export interface BackendProof {
  readonly kind: 'assertion';
  readonly assertion: string;
}

export interface BackendTransportConfig {
  baseUrl: string;
  callerId: string;
  credential: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type BackendFailureReason =
  | 'invalid_request'
  | 'transport_error'
  | 'auth_error'
  | 'http_error'
  | 'response_malformed';

export type BackendResponse =
  | { ok: true; body: unknown; httpStatus: number }
  | { ok: false; reason: BackendFailureReason; httpStatus: number | null };

export interface BackendIngressTuple {
  platform: string;
  workspace_id: string;
  platform_user_id: string;
  channel_id: string;
  event_id: string;
  event_ts: string | null;
}

export interface BackendTransport {
  readonly baseUrl: string;
  operations(operation: string, input: unknown, proof: BackendProof): Promise<BackendResponse>;
  resolveIdentity(proof: BackendProof): Promise<BackendResponse>;
  relayIngress(tuple: BackendIngressTuple): Promise<BackendResponse>;
  linkStart(proof: BackendProof): Promise<BackendResponse>;
  linkStatus(sessionId: string, proof: BackendProof): Promise<BackendResponse>;
  linkComplete(bindingCode: string, proof: BackendProof): Promise<BackendResponse>;
}

export const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_ASSERTION_LENGTH = 8192;
const MAX_BINDING_CODE_LENGTH = 512;
const MAX_LINK_SESSION_ID_LENGTH = 256;

const configError = (message: string): Error => new Error(`backend transport config: ${message}`);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isBackendProof(value: unknown): value is BackendProof {
  return (
    isPlainObject(value) &&
    value.kind === 'assertion' &&
    typeof value.assertion === 'string' &&
    value.assertion.length > 0 &&
    value.assertion.length <= MAX_ASSERTION_LENGTH
  );
}

export function createBackendProof(assertion: unknown): BackendProof | null {
  const candidate = { kind: 'assertion' as const, assertion };
  return isBackendProof(candidate) ? Object.freeze(candidate) : null;
}

export function createBackendTransport(config: BackendTransportConfig): BackendTransport {
  const rawUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (!rawUrl) throw configError('baseUrl is required');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw configError('baseUrl must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    if (parsedUrl.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(parsedUrl.hostname)) {
      throw configError('baseUrl must use https, or http on a loopback address for local development');
    }
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw configError('baseUrl must be a bare origin without credentials, query or fragment');
  }
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const callerId = typeof config?.callerId === 'string' ? config.callerId.trim() : '';
  if (!CALLER_ID_PATTERN.test(callerId)) {
    throw configError('callerId must be a registered caller identifier');
  }
  const credential = typeof config?.credential === 'string' ? config.credential.trim() : '';
  if (!credential) throw configError('credential is required');

  const timeoutMs = config?.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw configError('timeoutMs must be a positive integer');
  }

  const fetchImpl = config?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw configError('a fetch implementation is required');

  const post = async (path: string, body: unknown): Promise<BackendResponse> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-rein-caller-id': callerId,
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'transport_error', httpStatus: null };
    }
    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) {
      if (httpStatus === 401 || httpStatus === 403) {
        return { ok: false, reason: 'auth_error', httpStatus };
      }
      return { ok: false, reason: 'http_error', httpStatus };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, reason: 'response_malformed', httpStatus };
    }
    if (!isPlainObject(parsed)) return { ok: false, reason: 'response_malformed', httpStatus };
    return { ok: true, body: parsed, httpStatus };
  };

  const operations = async (
    operation: string,
    input: unknown,
    proof: BackendProof,
  ): Promise<BackendResponse> => {
    if (typeof operation !== 'string' || !OPERATION_PATTERN.test(operation)) {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    }
    if (!isBackendProof(proof)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    return post('/api/agent/operations', { operation, input: input ?? {}, proof });
  };

  const resolveIdentity = async (proof: BackendProof): Promise<BackendResponse> => {
    if (!isBackendProof(proof)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    return post('/api/identity/resolve', { proof });
  };

  const relayIngress = async (tuple: BackendIngressTuple): Promise<BackendResponse> => {
    if (!isPlainObject(tuple)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    const required = ['platform', 'workspace_id', 'platform_user_id', 'channel_id', 'event_id'] as const;
    for (const key of required) {
      if (typeof tuple[key] !== 'string' || !(tuple[key] as string).trim()) {
        return { ok: false, reason: 'invalid_request', httpStatus: null };
      }
    }
    return post('/api/ingress/relay', tuple);
  };

  const linkStart = async (proof: BackendProof): Promise<BackendResponse> => {
    if (!isBackendProof(proof)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    return post('/api/identity/link/start', { proof });
  };

  const linkStatus = async (sessionId: string, proof: BackendProof): Promise<BackendResponse> => {
    if (!isBackendProof(proof)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || id.length > MAX_LINK_SESSION_ID_LENGTH) {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    }
    return post('/api/identity/link/status', { session_id: id, proof });
  };

  const linkComplete = async (bindingCode: string, proof: BackendProof): Promise<BackendResponse> => {
    if (!isBackendProof(proof)) return { ok: false, reason: 'invalid_request', httpStatus: null };
    const code = typeof bindingCode === 'string' ? bindingCode.trim() : '';
    if (!code || code.length > MAX_BINDING_CODE_LENGTH) {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    }
    return post('/api/identity/link/complete', { binding_code: code, proof });
  };

  return Object.freeze({ baseUrl, operations, resolveIdentity, relayIngress, linkStart, linkStatus, linkComplete });
}
