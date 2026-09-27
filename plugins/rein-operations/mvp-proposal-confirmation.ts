// Verifiable author confirmation for the MVP proposal write path.
//
// PRD §2.3 step 2 and `workspace/AGENTS.md` require that a stored proposal is the version its
// author confirmed. The MVP proposal table has no draft status or confirmation column, so the
// confirmation cannot be a stored draft row. Instead the prepare step mints a short-lived token
// that binds one proposer to one exact payload, and the submit step refuses to write until it
// receives that token back together with an explicit confirmation statement.
//
// The token is an HMAC-SHA256 over a canonical JSON document, keyed by a server-only secret that
// lives in the process environment. It carries no credential of its own: the document it commits to
// is the proposer's own request text, and the signature only proves the server minted this exact
// binding. Verification re-derives the payload from the submitted arguments, so altering the title,
// the type, the amount or the currency after the preview invalidates the token.
//
// Replay: a token is bound to the proposer and the payload, and the identifier that becomes the
// proposal row's primary key is derived from that same binding. Submitting the same confirmed
// payload twice therefore addresses the same database row: the first write inserts it and the
// second is reported as the same record, so a retry cannot create a second proposal. A token is
// short-lived and expiry is enforced against the injected clock.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONFIRMATION_TOKEN_VERSION = 'rpc1';
// The token guards a long-lived write interface, so its prefix names the proposal confirmation
// itself rather than the MVP stage that first introduced it.
export const CONFIRMATION_TOKEN_PREFIX = 'rein_proposal_confirm';

/** How long a prepared proposal stays confirmable, in milliseconds. */
export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export interface ConfirmationPayload {
  proposerContactId: string;
  title: string;
  summary: string | null;
  voteType: string;
  requestedMinor: number | null;
  currency: string | null;
}

/** The public, caller-visible half of a prepared proposal. */
export interface ProposalConfirmationPreview {
  title: string;
  summary: string | null;
  voteType: string;
  requestedMinor: number | null;
  currency: string | null;
}

export type ConfirmationFailure =
  | 'proposal_confirmation_required'
  | 'proposal_confirmation_invalid'
  | 'proposal_confirmation_expired'
  | 'proposal_confirmation_mismatch';

export type ConfirmationVerification =
  | { ok: true; payload: ConfirmationPayload }
  | { ok: false; reason: ConfirmationFailure };

const DOCUMENT_VERSION = 1;

const canonicalDocument = (payload: ConfirmationPayload): string =>
  JSON.stringify({
    v: DOCUMENT_VERSION,
    proposerContactId: payload.proposerContactId,
    title: payload.title,
    summary: payload.summary,
    voteType: payload.voteType,
    requestedMinor: payload.requestedMinor,
    currency: payload.currency,
  });

/** The public, caller-visible half of a prepared proposal. */
export const confirmationPreview = (payload: ConfirmationPayload): ProposalConfirmationPreview => ({
  title: payload.title,
  summary: payload.summary,
  voteType: payload.voteType,
  requestedMinor: payload.requestedMinor,
  currency: payload.currency,
});

/**
 * Derive the stable proposal identifier from the signed binding. The identifier is a pure function
 * of the proposer and the confirmed content, so re-submitting the same confirmation addresses the
 * same record instead of inserting a second proposal.
 */
export const proposalIdForConfirmation = (payload: ConfirmationPayload, signingKey: string): string => {
  const digest = createHmac('sha256', signingKey).update(`proposal-id\u0000${canonicalDocument(payload)}`).digest();
  // Shape the digest as an RFC 4122 version-4 UUID so it satisfies the same column contract a
  // random identifier would, while staying deterministic for identical confirmed content.
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Mint one confirmation token that binds this proposer to this exact payload until `expiresAt`.
 * The signing key never leaves the process and never appears in the token or in a result.
 */
export function issueProposalConfirmation(
  payload: ConfirmationPayload,
  signingKey: string,
  now: Date,
): { token: string; expiresAt: string; proposalId: string } {
  const expiresAt = now.getTime() + CONFIRMATION_TTL_MS;
  const document = Buffer.from(canonicalDocument(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingKey)
    .update(`${CONFIRMATION_TOKEN_VERSION}.${expiresAt}.${document}`)
    .digest('base64url');
  return {
    token: `${CONFIRMATION_TOKEN_PREFIX}.${CONFIRMATION_TOKEN_VERSION}.${expiresAt}.${document}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
    proposalId: proposalIdForConfirmation(payload, signingKey),
  };
}

const sameSignature = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const decodeDocument = (document: string): ConfirmationPayload | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(document, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.v !== DOCUMENT_VERSION) return null;
  const proposerContactId = typeof doc.proposerContactId === 'string' ? doc.proposerContactId : null;
  const title = typeof doc.title === 'string' ? doc.title : null;
  const voteType = typeof doc.voteType === 'string' ? doc.voteType : null;
  const summary =
    doc.summary === null || typeof doc.summary === 'string' ? (doc.summary as string | null) : undefined;
  const requestedMinor =
    doc.requestedMinor === null ||
    (typeof doc.requestedMinor === 'number' && Number.isInteger(doc.requestedMinor))
      ? (doc.requestedMinor as number | null)
      : undefined;
  const currency =
    doc.currency === null || typeof doc.currency === 'string' ? (doc.currency as string | null) : undefined;
  if (!proposerContactId || !title || !voteType) return null;
  if (summary === undefined || requestedMinor === undefined || currency === undefined) return null;
  return { proposerContactId, title, summary, voteType, requestedMinor, currency };
};

/**
 * Verify a returned token against the payload the caller is now submitting.
 *
 * Four outcomes are kept apart so a caller can tell an omitted token from an altered one: a missing
 * token, a token the server did not mint, a token whose window has passed, and a valid token whose
 * signed payload differs from the current arguments.
 */
export function verifyProposalConfirmation(
  token: unknown,
  payload: ConfirmationPayload,
  signingKey: string,
  now: Date,
): ConfirmationVerification {
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, reason: 'proposal_confirmation_required' };
  }
  const parts = token.trim().split('.');
  if (parts.length !== 5) return { ok: false, reason: 'proposal_confirmation_invalid' };
  const [prefix, version, expiresText, document, signature] = parts;
  if (prefix !== CONFIRMATION_TOKEN_PREFIX || version !== CONFIRMATION_TOKEN_VERSION) {
    return { ok: false, reason: 'proposal_confirmation_invalid' };
  }
  const expectedSignature = createHmac('sha256', signingKey)
    .update(`${version}.${expiresText}.${document}`)
    .digest('base64url');
  if (!sameSignature(signature, expectedSignature)) {
    return { ok: false, reason: 'proposal_confirmation_invalid' };
  }
  const decoded = decodeDocument(document);
  if (decoded === null) return { ok: false, reason: 'proposal_confirmation_invalid' };
  const expiresAt = Number(expiresText);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, reason: 'proposal_confirmation_expired' };
  }
  if (canonicalDocument(decoded) !== canonicalDocument(payload)) {
    return { ok: false, reason: 'proposal_confirmation_mismatch' };
  }
  return { ok: true, payload: decoded };
}
