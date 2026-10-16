const UPSTREAM_AUTH_MESSAGE = '502 Magpie upstream account authentication failed; reauthenticate this upstream account in Magpie.';
const QUALIFIED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const BILLING_EVIDENCE = /\b(?:billing|credits?|balance|quota|payments?|budgets?|allowance)\b/i;
const AUTHENTICATION_EVIDENCE = /\b(?:authentication|unauthori[sz]ed|reauthenticate|reauthentication)\b/i;
const TOKEN_EVIDENCE = /\b(?:invalid|expired|revoked|missing)\s+(?:(?:api|access|refresh)\s+)?(?:key|token|credentials?)\b|\b(?:(?:api|access|refresh)\s+)?(?:key|token|credentials?)\s+(?:(?:is|has|has been)\s+)?(?:invalid|expired|revoked|missing)\b/i;

function matchesUpstream(scope) {
  if (!scope || typeof scope !== 'object' || ![401, 403].includes(scope.status) ||
      typeof scope.expectedModel !== 'string' || scope.expectedModel.length > 320 ||
      !QUALIFIED_MODEL.test(scope.expectedModel) || /^group\//i.test(scope.expectedModel) ||
      scope.expectedModel.includes('//') || scope.expectedModel.endsWith('/') ||
      scope.expectedModel.split('/').some(part => part === '.' || part === '..')) return false;
  // Raw Magpie headers identify the member selected before the upstream call.
  // Human provider labels, response text and model aliases establish no scope.
  return scope.gatewayMember === scope.expectedModel &&
    scope.provider === scope.expectedModel.slice(0, scope.expectedModel.indexOf('/'));
}

/**
 * Preserve gateway-key failures while allowing a declared healthy fallback for
 * a separately identified upstream account's authentication failure. Scope must
 * come from the current HTTP response, never a prompt or an error-body claim.
 */
export function normalizeUpstreamAuthenticationError(message, scope) {
  if (!message || typeof message !== 'object' || message.role !== 'assistant' ||
      message.stopReason !== 'error' || typeof message.errorMessage !== 'string' ||
      message.errorMessage.length === 0 || message.errorMessage.length > 16384 ||
      !matchesUpstream(scope)) return message;
  if (scope.status === 403) {
    const errorType = typeof message.errorType === 'string' && message.errorType.length <= 256 ? message.errorType : '';
    const evidence = `${errorType} ${message.errorMessage}`.replace(/[_-]+/g, ' ');
    // 403 also covers gateway budgets and upstream payment restrictions. Only
    // explicit account authentication evidence warrants retrying another route.
    if (BILLING_EVIDENCE.test(evidence) ||
        !(AUTHENTICATION_EVIDENCE.test(evidence) || TOKEN_EVIDENCE.test(evidence))) return message;
  }
  return { ...message, status: 502, errorCode: '502', errorType: 'server_error',
    errorMessage: UPSTREAM_AUTH_MESSAGE,
    errorBody: JSON.stringify({ error: { code: 'magpie_upstream_authentication_failed',
      type: 'server_error', message: UPSTREAM_AUTH_MESSAGE } }) };
}
