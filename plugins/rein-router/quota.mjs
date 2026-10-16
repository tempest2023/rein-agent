const INCLUDED_QUOTA_MESSAGE = '429 subscription quota limit reached; automatic quota refresh required (included allowance exhausted)';
const QUOTA_SOURCE = /\b(?:included|subscription|coding[ _-]+plan)\b/i;
const QUOTA_LIMIT = /\b(?:quota|allowance|usage[ _-]+limit)\b/i;
const EXHAUSTION = /\b(?:exhausted|depleted|used[ _-]+up|reached|exceeded|no[ _-]+remaining|insufficient[ _-]+quota)\b/i;
// A gateway credential fault or an actual payment/balance failure applies to
// the gateway boundary. It must retain native fail-closed credential handling.
const BILLING_OR_AUTH = /\b(?:credits?|balance|payment|billing|unauthori[sz]ed|authentication|invalid[ _-]+(?:api[ _-]+)?key|(?:api|gateway)[ _-]+key|access[ _-]+denied)\b/i;

function quotaStatus(message, text) {
  if (message.status === 402 || message.status === 429) return message.status;
  if (message.errorCode === '402' || message.errorCode === '429') return Number(message.errorCode);
  const match = /^\s*(?:error[:\s-]+)?(?:http\s*)?(402|429)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Included upstream allowances belong to one route, not the shared Magpie key.
 * OpenClaw otherwise treats HTTP 402 as a gateway-wide billing failure. Give
 * only explicit allowance exhaustion its native long-window rate-limit shape.
 */
export function normalizeIncludedQuotaError(message) {
  if (!message || typeof message !== 'object' || message.stopReason !== 'error' ||
      typeof message.errorMessage !== 'string' || message.errorMessage.length > 16384) return message;
  const status = quotaStatus(message, message.errorMessage);
  if (status !== 402 && status !== 429) return message;
  // "Payment Required" can be HTTP's status label; remaining payment language
  // still refuses normalization even when the error also mentions a quota.
  const text = message.errorMessage.replace(/^\s*(?:error[:\s-]+)?(?:http\s*)?(?:402|429)\b\s*(?:payment required\b)?[:\s-]*/i, '');
  const type = typeof message.errorType === 'string' && message.errorType.length <= 256 ? message.errorType : '';
  const evidence = `${type} ${text}`;
  if (BILLING_OR_AUTH.test(evidence) || !QUOTA_SOURCE.test(evidence) ||
      !QUOTA_LIMIT.test(evidence) || !EXHAUSTION.test(text)) return message;
  return { ...message, errorMessage: INCLUDED_QUOTA_MESSAGE, errorCode: '429', errorType: 'rate_limit_error',
    errorBody: JSON.stringify({ error: { code: 'included_allowance_exhausted',
      type: 'rate_limit_error', message: INCLUDED_QUOTA_MESSAGE } }) };
}

/** Preserve AsyncIterable + result(), sharing one optional async normalization per terminal error. */
export function wrapQuotaErrors(source, normalizeError = normalizeIncludedQuotaError) {
  if (source && typeof source.then === 'function') return Promise.resolve(source).then(value => wrapQuotaErrors(value, normalizeError));
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' || typeof source.result !== 'function') {
    throw new TypeError('rein_router_quota_stream_invalid');
  }
  const normalized = new WeakMap();
  const normalize = message => {
    if (!message || typeof message !== 'object' || message.stopReason !== 'error') return message;
    if (normalized.has(message)) return normalized.get(message);
    // Cache before invoking the callback so event/result consumers share both
    // async lookup work and failures, without consuming the source in advance.
    const result = Promise.resolve().then(() => normalizeError(message));
    normalized.set(message, result);
    return result;
  };
  let resultPromise;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (event?.type === 'error' && event.reason !== 'aborted') {
          const error = await normalize(event.error);
          yield error === event.error ? event : { ...event, error };
        } else yield event;
      }
    },
    result() {
      // Source throws/rejections and cancellation keep their original identity.
      return resultPromise ??= Promise.resolve().then(() => source.result()).then(normalize);
    },
  };
}
