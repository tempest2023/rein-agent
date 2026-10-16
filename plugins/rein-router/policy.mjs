import { isAbsolute } from 'node:path';

const PROVIDER_ID = 'rein-magpie';
const ROUTE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const RESERVED_ENV = /^(?:HOME|USERPROFILE|PATH|SHELL|PWD|OLDPWD|USER|LOGNAME|LANG|TZ|TMP|TEMP|TMPDIR|APPDATA|LOCALAPPDATA|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_CLI_HOME|ENV|BASH_ENV|ZDOTDIR|MAGPIE_ADDR|MAGPIE_NO_ACCOUNTS|MAGPIE_TRUST_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|SYSTEMROOT|COMSPEC|PATHEXT)$|^(?:XDG_|NODE_|NPM_|PNPM_|OPENCLAW_|DYLD_|LD_)/;
const GATEWAY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const CHANNELS = ['discord', 'slack'];
const EFFORTS = ['off', 'low', 'medium', 'high'];
const BILLING_MODES = ['subscription', 'coding-plan', 'pay-as-you-go'];

export const isGatewayCredentialEnvironmentName = value => typeof value === 'string' && ENV_NAME.test(value) && !RESERVED_ENV.test(value);

// Errors deliberately contain only a fixed code and a schema-controlled field.
// Neither invalid values nor unknown property names are safe to print.
function invalid(field, code = 'router_config_invalid') {
  const error = new Error(`${code}: ${field}`);
  error.code = code;
  error.field = field;
  throw error;
}

function object(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(field, 'router_config_unknown_field');
  return value;
}

function boolean(value, field, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function text(value, field, maxLength = 256) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      value.length > maxLength || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) invalid(field);
  return value;
}

function integer(value, field, minimum, maximum, defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(field);
  return value;
}

function array(value, field, maxLength = 64, defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!Array.isArray(value) || value.length > maxLength) invalid(field);
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid(field);
  return value;
}

function oneOf(value, field, choices) {
  if (!choices.includes(value)) invalid(field);
  return value;
}

function routeId(value, field) {
  if (typeof value !== 'string' || !ROUTE_ID.test(value) || value === 'auto') invalid(field);
  return value;
}

function gateway(raw) {
  object(raw, 'gateway', ['baseUrl', 'apiKeyEnvVar', 'subscriptionOnly', 'managed']);
  const baseUrl = text(raw.baseUrl, 'gateway.baseUrl', 512);
  let parsed;
  try { parsed = new URL(baseUrl); } catch { invalid('gateway.baseUrl'); }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/v1' || baseUrl.includes('\\')) invalid('gateway.baseUrl');
  const apiKeyEnvVar = text(raw.apiKeyEnvVar, 'gateway.apiKeyEnvVar', 128);
  if (!isGatewayCredentialEnvironmentName(apiKeyEnvVar)) invalid('gateway.apiKeyEnvVar');
  let managed;
  if (raw.managed !== undefined) {
    object(raw.managed, 'gateway.managed', ['binaryPath', 'homeDir', 'allowSubscriptionAccounts']);
    const binaryPath = text(raw.managed.binaryPath, 'gateway.managed.binaryPath', 4096);
    const homeDir = text(raw.managed.homeDir, 'gateway.managed.homeDir', 4096);
    if (!isAbsolute(binaryPath) || !isAbsolute(homeDir)) invalid('gateway.managed');
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.port)
      invalid('gateway.baseUrl');
    managed = { binaryPath, homeDir,
      allowSubscriptionAccounts: boolean(raw.managed.allowSubscriptionAccounts, 'gateway.managed.allowSubscriptionAccounts', false) };
  }
  return { baseUrl: parsed.href, apiKeyEnvVar, ...(managed ? { managed } : {}),
    subscriptionOnly: boolean(raw.subscriptionOnly, 'gateway.subscriptionOnly', true) };
}

function route(raw, index) {
  const field = `routes[${index}]`;
  object(raw, field, ['id', 'provider', 'gatewayModel', 'billingSource', 'billingMode',
    'billingVerified', 'purpose', 'effort', 'contextWindow', 'maxTokens']);
  const id = routeId(raw.id, `${field}.id`);
  const gatewayModel = text(raw.gatewayModel, `${field}.gatewayModel`, 320);
  if (!GATEWAY_MODEL.test(gatewayModel) || /^group\//i.test(gatewayModel) ||
      gatewayModel.includes('//') || gatewayModel.endsWith('/') ||
      gatewayModel.split('/').some(part => part === '.' || part === '..')) invalid(`${field}.gatewayModel`);
  const contextWindow = integer(raw.contextWindow, `${field}.contextWindow`, 1, Number.MAX_SAFE_INTEGER);
  return { id, provider: text(raw.provider, `${field}.provider`, 128), gatewayModel,
    billingSource: text(raw.billingSource, `${field}.billingSource`, 512),
    billingMode: oneOf(raw.billingMode, `${field}.billingMode`, BILLING_MODES),
    billingVerified: boolean(raw.billingVerified, `${field}.billingVerified`, false),
    purpose: text(raw.purpose, `${field}.purpose`, 1024),
    effort: oneOf(raw.effort, `${field}.effort`, EFFORTS), contextWindow,
    maxTokens: integer(raw.maxTokens, `${field}.maxTokens`, 1, contextWindow) };
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate operator configuration without resolving secrets or contacting services. */
export function validateRouterConfig(raw = {}) {
  object(raw, 'config', ['enabled', 'gateway', 'routes', 'defaultRoute', 'fallbackRoutes',
    'allowPaidUsage', 'channels', 'adminSenders', 'decision']);
  const enabled = boolean(raw.enabled, 'enabled', false);
  const allowPaidUsage = boolean(raw.allowPaidUsage, 'allowPaidUsage', false);
  const normalizedGateway = raw.gateway === undefined ? null : gateway(raw.gateway);
  const routes = array(raw.routes, 'routes', 64, []).map(route);
  const ids = new Set();
  for (const [index, candidate] of routes.entries()) {
    if (ids.has(candidate.id)) invalid(`routes[${index}].id`, 'router_config_duplicate_route');
    ids.add(candidate.id);
    if (candidate.billingMode === 'pay-as-you-go' &&
        (!allowPaidUsage || normalizedGateway?.subscriptionOnly !== false)) {
      invalid(`routes[${index}].billingMode`, 'router_paid_usage_not_authorized');
    }
    if (enabled && !candidate.billingVerified) invalid(`routes[${index}].billingVerified`, 'router_billing_unverified');
  }
  const defaultRoute = raw.defaultRoute === undefined ? null : routeId(raw.defaultRoute, 'defaultRoute');
  if (defaultRoute !== null && !ids.has(defaultRoute)) invalid('defaultRoute', 'router_config_unknown_route');
  const fallbackRoutes = array(raw.fallbackRoutes, 'fallbackRoutes', 64, []).map((id, index) => {
    routeId(id, `fallbackRoutes[${index}]`);
    if (!ids.has(id)) invalid(`fallbackRoutes[${index}]`, 'router_config_unknown_route');
    return id;
  });
  if (new Set(fallbackRoutes).size !== fallbackRoutes.length) invalid('fallbackRoutes', 'router_config_duplicate_route');
  const channels = array(raw.channels, 'channels', 2, [...CHANNELS]).map((channel, index) =>
    oneOf(channel, `channels[${index}]`, CHANNELS));
  if (new Set(channels).size !== channels.length) invalid('channels');
  const adminSenders = array(raw.adminSenders, 'adminSenders', 256, []).map((sender, index) => {
    const field = `adminSenders[${index}]`;
    object(sender, field, ['channel', 'accountId', 'senderId']);
    return { channel: oneOf(sender.channel, `${field}.channel`, CHANNELS),
      accountId: text(sender.accountId, `${field}.accountId`, 128),
      senderId: text(sender.senderId, `${field}.senderId`, 256) };
  });
  if (new Set(adminSenders.map(sender => JSON.stringify(sender))).size !== adminSenders.length) invalid('adminSenders');
  const decisionRaw = raw.decision === undefined ? {} : raw.decision;
  object(decisionRaw, 'decision', ['timeoutMs', 'minProbability', 'maxPromptChars', 'allowPaidJev']);
  const minProbability = decisionRaw.minProbability === undefined ? 0.8 : decisionRaw.minProbability;
  if (typeof minProbability !== 'number' || !Number.isFinite(minProbability) ||
      minProbability < 0 || minProbability > 1) invalid('decision.minProbability');
  const decision = {
    timeoutMs: integer(decisionRaw.timeoutMs, 'decision.timeoutMs', 100, 10000, 3000),
    minProbability,
    maxPromptChars: integer(decisionRaw.maxPromptChars, 'decision.maxPromptChars', 100, 32000, 4000),
    allowPaidJev: boolean(decisionRaw.allowPaidJev, 'decision.allowPaidJev', false),
  };
  if (enabled && !normalizedGateway) invalid('gateway');
  if (enabled && routes.length === 0) invalid('routes');
  if (enabled && defaultRoute === null) invalid('defaultRoute');
  if (enabled && channels.length === 0) invalid('channels');
  return freeze({ enabled, gateway: normalizedGateway ?? undefined, routes, defaultRoute: defaultRoute ?? undefined, fallbackRoutes,
    allowPaidUsage, channels, adminSenders, decision });
}

function enabledConfig(config) {
  // Revalidation also protects callers supplying a forged normalized object.
  const normalized = validateRouterConfig(config);
  if (!normalized.enabled) invalid('enabled', 'router_disabled');
  return normalized;
}

/** Create a reviewable merge fragment; this function never reads or writes live config. */
export function buildOpenClawFragment(raw, pluginPath) {
  const config = enabledConfig(raw);
  if (typeof pluginPath !== 'string' || !isAbsolute(pluginPath) ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(pluginPath)) invalid('pluginPath');
  const models = [
    { id: 'auto', name: 'Rein dynamic router', reasoning: config.routes.some(candidate => candidate.effort !== 'off'),
      input: ['text'], contextWindow: Math.min(...config.routes.map(candidate => candidate.contextWindow)),
      maxTokens: Math.min(...config.routes.map(candidate => candidate.maxTokens)) },
    ...config.routes.map(candidate => ({ id: candidate.id, name: `${candidate.provider}: ${candidate.gatewayModel}`,
      reasoning: candidate.effort !== 'off', input: ['text'],
      contextWindow: candidate.contextWindow, maxTokens: candidate.maxTokens })),
  ];
  return {
    models: { mode: 'merge', providers: { [PROVIDER_ID]: {
      baseUrl: config.gateway.baseUrl, api: 'openai-completions',
      apiKey: { source: 'env', provider: 'default', id: config.gateway.apiKeyEnvVar }, models,
    } } },
    agents: { defaults: {
      model: { primary: `${PROVIDER_ID}/auto`, fallbacks: config.fallbackRoutes.map(id => `${PROVIDER_ID}/${id}`) },
      models: Object.fromEntries(['auto', ...config.routes.map(candidate => candidate.id)]
        .map(id => [`${PROVIDER_ID}/${id}`, { alias: id === 'auto' ? 'rein-auto' : `rein-${id}` }])),
    } },
    plugins: { allow: ['rein-router'], load: { paths: [pluginPath] },
      entries: { 'rein-router': { enabled: true, hooks: { allowConversationAccess: true }, config } } },
  };
}

/** Select only an authorized catalog entry. Uncertain decisions use the capable default. */
export function selectRoute(raw, outcome, { admin = false, hasAttachments = false } = {}) {
  const config = enabledConfig(raw);
  const defaultRoute = config.routes.find(candidate => candidate.id === config.defaultRoute);
  const fallback = reason => ({ route: defaultRoute, reason });
  // Host-derived admin status is used in the decision prompt, never inferred here.
  void admin;
  if (hasAttachments) return fallback('attachments');
  if (!outcome || outcome.status !== 'ok') return fallback('decision-unavailable');
  const answer = outcome.result?.answers?.route;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' ||
      !answer.probabilities || typeof answer.probabilities !== 'object' ||
      Array.isArray(answer.probabilities)) return fallback('decision-invalid');
  const candidate = config.routes.find(item => item.id === answer.choice);
  if (!candidate || !candidate.billingVerified ||
      (candidate.billingMode === 'pay-as-you-go' &&
        (!config.allowPaidUsage || config.gateway.subscriptionOnly))) return fallback('decision-invalid');
  const probability = Object.hasOwn(answer.probabilities, candidate.id) ? answer.probabilities[candidate.id] : undefined;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return fallback('decision-invalid');
  }
  if (probability < config.decision.minProbability) return fallback('low-probability');
  return { route: candidate, reason: 'jev', probability };
}

/** Operator declarations are provenance hints, not independent billing evidence. */
export function describeRoute(raw, id) {
  const config = validateRouterConfig(raw);
  const candidate = config.routes.find(item => item.id === id);
  if (!candidate) invalid('routeId', 'router_config_unknown_route');
  return { routeId: candidate.id, provider: candidate.provider, model: candidate.gatewayModel,
    billingSource: candidate.billingSource, billingMode: candidate.billingMode,
    billingVerified: candidate.billingVerified, verification: 'operator-configured', effort: candidate.effort };
}
