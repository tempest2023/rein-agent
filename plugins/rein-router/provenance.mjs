import { randomUUID } from 'node:crypto';

const MAX_BYTES = 64 * 1024;
const MAX_WAIT_MS = 750;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,319}$/;
const EFFORTS = new Set(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const safeModel = value => typeof value === 'string' && MODEL.test(value) ? value : null;
const memberProvider = value => {
  if (!safeModel(value)) return null;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const provider = value.slice(0, slash);
  return PROVIDER.test(provider) ? provider : null;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Per-call opaque correlation; never send native user/channel/session identities. */
export function createGatewayRequestHeaders(existing) {
  const headers = new Headers(existing);
  const session = randomUUID();
  headers.set('X-Magpie-Session', session);
  headers.set('X-Magpie-Response-Model', 'vendor');
  // Magpie's ordinary loopback path accepts stale named keys as unrestricted.
  // Its documented null-origin path authenticates every call before routing.
  headers.set('Origin', 'null');
  return { session, headers: Object.fromEntries(headers) };
}

/** A Magpie header identifies the gateway member, not the vendor's reply model. */
export function readGatewayMemberIdentity(rawHeaders) {
  let headers;
  try { headers = new Headers(rawHeaders); } catch { return null; }
  const rawProvider = headers.get('X-Magpie-Provider');
  const provider = typeof rawProvider === 'string' && PROVIDER.test(rawProvider) ? rawProvider : null;
  const rawMember = headers.get('X-Magpie-Model');
  const gatewayMember = memberProvider(rawMember) ? rawMember : null;
  if (provider && gatewayMember && memberProvider(gatewayMember) !== provider) return null;
  if (!provider && !gatewayMember) return null;
  return { provider: provider ?? memberProvider(gatewayMember), gatewayMember };
}

export function readGatewayHeaderEvidence(response) {
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return null;
  const identity = readGatewayMemberIdentity(response.headers);
  if (!identity) return null;
  return { ...identity,
    vendorServedModel: null, effort: null, evidence: 'gateway-response-headers' };
}

function routeEndpoint(baseUrl, session) {
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
        base.username || base.password || base.search || base.hash || base.pathname !== '/v1' ||
        !UUID.test(session)) return null;
    const endpoint = new URL(`${base.href}/magpie/route`);
    endpoint.searchParams.set('session', session);
    return endpoint;
  } catch { return null; }
}

async function boundedJson(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return null;
  if (!response.body || typeof response.body.getReader !== 'function') return null;
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* no raw errors */ } };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || (total += next.value.byteLength) > MAX_BYTES) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    // Metadata cleanup must not extend the bounded foreground deadline.
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

function traceEvidence(value, session, expectedModel, headerEvidence) {
  if (!object(value) || value.session !== session || !object(value.route)) return null;
  const route = value.route;
  // Pinned Magpie strips the effort suffix before recording route.asked.
  // Response EOF can arrive before Magpie publishes the completed route.
  if (route.asked === expectedModel && route.done === false) return undefined;
  if (route.done !== true || !Number.isInteger(route.status) || route.status < 200 || route.status >= 300 ||
      route.asked !== expectedModel) return null;
  const provider = memberProvider(route.model);
  if (!provider || (headerEvidence?.provider && headerEvidence.provider !== provider) ||
      (headerEvidence?.gatewayMember && headerEvidence.gatewayMember !== route.model)) return null;
  return { provider, gatewayMember: route.model, vendorServedModel: safeModel(route.served),
    effort: EFFORTS.has(route.effort) ? route.effort : null, evidence: 'gateway-session-route' };
}

/** Read only this opaque call's completed route; no accounts, quotas or usage APIs. */
async function readGatewayTrace({ baseUrl, gatewayKey, session, expectedModel,
  fetchImpl = globalThis.fetch, timeoutMs = MAX_WAIT_MS }, select, fallback) {
  const endpoint = routeEndpoint(baseUrl, session);
  if (!endpoint || !memberProvider(expectedModel) || typeof fetchImpl !== 'function' ||
      typeof gatewayKey !== 'string' || !/^sk-magpie-key-[A-Za-z0-9_-]{16,240}$/.test(gatewayKey)) return fallback;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(null); },
      Math.min(MAX_WAIT_MS, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MAX_WAIT_MS));
  });
  const read = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(endpoint.href, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${gatewayKey}`, Accept: 'application/json', Origin: 'null' }, signal: controller.signal });
      if (!response || !response.ok || response.redirected ||
          (response.url && response.url !== endpoint.href)) return null;
      const value = await boundedJson(response, controller.signal);
      const selected = select(value);
      if (selected !== undefined) return selected;
      // Response EOF may precede trace finalization. Use Magpie's bounded change
      // wait rather than assuming an unfinished record is upstream evidence.
      if (!Number.isSafeInteger(value?.seq) || value.seq < 1 || endpoint.searchParams.get('after') === String(value.seq)) return null;
      endpoint.searchParams.set('after', String(value.seq));
      endpoint.searchParams.set('wait', '0.5');
    }
    return null;
  };
  try { return await Promise.race([read(), deadline]) ?? fallback; }
  catch { return fallback; }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function readGatewayRouteEvidence(options) {
  const { session, expectedModel, headerEvidence = null } = options;
  return readGatewayTrace(options, value => traceEvidence(value, session, expectedModel, headerEvidence), headerEvidence);
}

/** SDK errors bypass onResponse. Only a completed, matching upstream try can
 * distinguish that account's authentication failure from the gateway's key. */
export async function readGatewayAuthenticationScope(options) {
  const { session, expectedModel } = options;
  return readGatewayTrace(options, value => {
    if (!object(value) || value.session !== session || !object(value.route)) return null;
    const route = value.route;
    if (route.asked === expectedModel && route.done === false) return undefined;
    const last = Array.isArray(route.tries) ? route.tries.at(-1) : null;
    if (route.done !== true || ![401, 403].includes(route.status) || route.asked !== expectedModel ||
        route.model !== expectedModel || !object(last) || last.done !== true ||
        last.model !== expectedModel || last.status !== route.status ||
        !route.tries.every(item => object(item) && item.model === expectedModel)) return null;
    const provider = memberProvider(expectedModel);
    return provider ? { status: route.status, provider, gatewayMember: expectedModel, expectedModel } : null;
  }, null);
}
