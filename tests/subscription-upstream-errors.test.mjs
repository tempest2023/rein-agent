import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstreamAuthenticationError } from '../plugins/rein-router/upstream-errors.mjs';

const canonical = '502 Magpie upstream account authentication failed; reauthenticate this upstream account in Magpie.';
const scope = overrides => ({ status: 401, provider: 'codex', gatewayMember: 'codex/gpt-fixture', expectedModel: 'codex/gpt-fixture', ...overrides });
const message = overrides => ({ role: 'assistant', stopReason: 'error',
  errorMessage: '401: Synthetic upstream account token expired; PRIVATE-ERROR-CANARY',
  errorCode: '401', errorType: 'authentication_error', errorBody: 'PRIVATE-BODY-CANARY',
  provider: 'rein-magpie', model: 'codex-alias', api: 'openai-completions',
  content: [{ type: 'toolCall', id: 'synthetic-call', name: 'read', arguments: {} }],
  usage: { input: 12, output: 3 }, timestamp: 1, ...overrides });

test('matched upstream 401 becomes a safe server error without poisoning the shared gateway key', () => {
  const original = message();
  const normalized = normalizeUpstreamAuthenticationError(original, scope());
  assert.notEqual(normalized, original);
  assert.equal(normalized.errorMessage, canonical);
  assert.equal(normalized.status, 502);
  assert.equal(normalized.errorCode, '502');
  assert.equal(normalized.errorType, 'server_error');
  assert.deepEqual(JSON.parse(normalized.errorBody), { error: {
    code: 'magpie_upstream_authentication_failed', type: 'server_error', message: canonical,
  } });
  assert.equal(normalized.provider, original.provider);
  assert.equal(normalized.model, original.model);
  assert.equal(normalized.api, original.api);
  assert.equal(normalized.content, original.content);
  assert.equal(normalized.usage, original.usage);
  assert.equal(normalized.timestamp, original.timestamp);
  assert.ok(!normalized.errorMessage.includes('CANARY'));
  assert.ok(!normalized.errorBody.includes('CANARY'));
  assert.ok(!normalized.errorType.includes('CANARY'));
  assert.equal(original.errorCode, '401');
  assert.equal(original.errorBody, 'PRIVATE-BODY-CANARY');
});

test('trusted HTTP response status controls normalization rather than reflected response text', () => {
  const generic = message({ errorMessage: 'Unknown upstream response.', errorType: undefined, errorCode: undefined });
  assert.equal(normalizeUpstreamAuthenticationError(generic, scope()).errorCode, '502');
  const reflected = message({ errorMessage: '401: codex/gpt-fixture authentication failed' });
  assert.equal(normalizeUpstreamAuthenticationError(reflected, scope({ status: 200 })), reflected);
  assert.equal(normalizeUpstreamAuthenticationError(reflected, {}), reflected);
});

for (const evidence of [
  '403: Authentication failed.', '403: Unauthorized upstream account.',
  '403: Token expired.', '403: The access token has expired.',
  '403: Invalid API key.', '403: Refresh token revoked.',
  '403: Missing credentials.', '403: Please reauthenticate.',
  '403: {"error":{"type":"invalid_api_key"}}',
]) test(`matched upstream 403 requires clear authentication evidence: ${evidence}`, () => {
  const normalized = normalizeUpstreamAuthenticationError(message({
    errorMessage: evidence, errorCode: '403', errorType: undefined,
  }), scope({ status: 403 }));
  assert.equal(normalized.errorCode, '502');
  assert.equal(normalized.errorMessage, canonical);
});

test('bounded structured authentication type can supply evidence for an upstream 403', () => {
  const original = message({ errorMessage: '403: Request rejected.', errorType: 'authentication_error' });
  assert.equal(normalizeUpstreamAuthenticationError(original, scope({ status: 403 })).errorCode, '502');
  const unbounded = { ...original, errorType: `authentication_error${'x'.repeat(256)}` };
  assert.equal(normalizeUpstreamAuthenticationError(unbounded, scope({ status: 403 })), unbounded);
});

for (const evidence of [
  '403: Forbidden.', '403: Access denied.', '403: Account is not authorized to use this model.',
  '403: Authentication failed; gateway budget exceeded.',
  '403: Invalid API key; insufficient credit.',
  '403: Token expired; subscription quota exhausted.',
  '403: Authentication failed; balance too low.',
  '403: Authentication failed; payment required.',
  '403: Authentication failed; billing limit reached.',
  '403: Authentication failed; included allowance exhausted.',
  '403: {"error":{"type":"gateway_budget_exceeded","message":"Invalid API key"}}',
]) test(`403 authorization or payment evidence stays fail-closed: ${evidence}`, () => {
  const original = message({ errorMessage: evidence, errorCode: '403', errorType: undefined });
  assert.equal(normalizeUpstreamAuthenticationError(original, scope({ status: 403 })), original);
});

test('payment evidence in structured type also prevents upstream 403 normalization', () => {
  const original = message({ errorMessage: '403: Token expired.', errorCode: '403', errorType: 'billing_error' });
  assert.equal(normalizeUpstreamAuthenticationError(original, scope({ status: 403 })), original);
});

test('a gateway 401 without an exact upstream member preserves native credential handling', () => {
  const original = message({ errorMessage: '401: Invalid gateway API key.' });
  for (const captured of [undefined, null, {}, scope({ gatewayMember: undefined }), scope({ provider: undefined }),
    scope({ gatewayMember: '' }), scope({ expectedModel: undefined }), scope({ provider: 'rein-magpie' }),
  ]) assert.equal(normalizeUpstreamAuthenticationError(original, captured), original);
});

test('scope must match both declared raw provider and full model exactly', () => {
  const original = message();
  for (const captured of [
    scope({ gatewayMember: 'codex/another-model' }), scope({ gatewayMember: 'codex/gpt-fixture:high' }),
    scope({ gatewayMember: 'CODEX/gpt-fixture' }), scope({ provider: 'CODEX' }),
    scope({ provider: 'codex-other' }), scope({ expectedModel: 'codex-alias' }),
    scope({ expectedModel: 'group/best', gatewayMember: 'group/best', provider: 'group' }),
    scope({ expectedModel: 'codex/gpt-fixture:high', gatewayMember: 'codex/gpt-fixture:high' }),
    scope({ expectedModel: 'codex/gpt fixture', gatewayMember: 'codex/gpt fixture' }),
    scope({ expectedModel: 'codex/../model', gatewayMember: 'codex/../model' }),
  ]) assert.equal(normalizeUpstreamAuthenticationError(original, captured), original);
});

test('non-authentication HTTP status cannot be upgraded by body or model claims', () => {
  const original = message();
  for (const status of [200, 400, 402, 404, 429, 500, 502, '401', '403', NaN]) {
    assert.equal(normalizeUpstreamAuthenticationError(original, scope({ status })), original);
  }
});

test('successful, tool-use, cancelled and non-assistant messages preserve exact references', () => {
  for (const stopReason of ['stop', 'toolUse', 'aborted', undefined]) {
    const original = message({ stopReason });
    assert.equal(normalizeUpstreamAuthenticationError(original, scope()), original);
  }
  for (const role of ['user', 'toolResult', undefined]) {
    const original = message({ role });
    assert.equal(normalizeUpstreamAuthenticationError(original, scope()), original);
  }
});

test('missing, malformed and oversized error messages remain untouched', () => {
  for (const value of [null, undefined, '401 authentication error', [], {},
    message({ errorMessage: undefined }), message({ errorMessage: '' }),
    message({ errorMessage: 401 }), message({ errorMessage: 'x'.repeat(16385) }),
  ]) assert.equal(normalizeUpstreamAuthenticationError(value, scope()), value);
  assert.equal(normalizeUpstreamAuthenticationError(message({ errorMessage: 'x'.repeat(16384) }), scope()).errorMessage, canonical);
});
