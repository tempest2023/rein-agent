// Sealed multi-turn draft for the v0.1 proposal field-collection tool (case 3).
//
// The proposal table has no draft status and no draft column, so a draft cannot be a stored row.
// Instead one short-lived token carries the fields the proposer has said so far, so a later turn can
// continue from them without the model retyping, and without the server keeping state. The token is
// the same sealed-binding shape as the author confirmation in `proposal-confirmation.ts`, but it
// belongs to its own purpose and its own domain.
//
// Domain separation. Two things keep a draft token from being mistaken for a submit confirmation, or
// the reverse:
// - A different envelope prefix and version (`rein_proposal_draft.rpd1`) versus
//   (`rein_proposal_confirm.rpc2`). A reader of one shape refuses the other's token before any key is
//   derived, so neither tool can open the other's token by accident.
// - A different HKDF salt and label over the same server-only secret, so the AES-256-GCM keys of the
//   two purposes are unrelated: even a token whose prefix were spoofed would fail authentication
//   under the other purpose's key.
//
// Confidentiality. The plaintext carries the proposer's own text and the private contact identifier,
// so no readable part of the token names the proposer or repeats the text. The expiry, the token
// version and the proposer binding travel as additional authenticated data, so a token cannot be
// re-dated or moved to another proposer: the ciphertext fails authentication instead of decrypting.
//
// Size. Encryption preserves length rather than shrinking it, so the token can be larger than the
// text it carries. The schema cap is derived from the cap and fence the confirmation module measured
// for the longest legal payload in the widest encoding, so the collect tool advertises a bound that
// matches what this module will actually mint. A document over the fence, or one whose token would
// still exceed the cap, is refused before a token is handed out.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  MAX_CONFIRMATION_TOKEN_LENGTH,
  maxDocumentBytesForToken,
} from './proposal-confirmation.ts';

export const DRAFT_TOKEN_VERSION = 'rpd1';
export const DRAFT_TOKEN_PREFIX = 'rein_proposal_draft';

/**
 * The one cap this purpose uses, in characters, for the mint path's own length check, the document
 * fence derived from it, and the `maxLength` the tool schema advertises. It is not a fresh guess:
 * the confirmation module's own cap was a measured bound for the longest legal payload in the widest
 * encoding, and this envelope is one character wider at the prefix, so the draft cap is that measured
 * bound translated once, by the width difference, and then reused everywhere instead of re-derived.
 *
 * The schema counts characters and the token is ASCII once base64url-encoded, so characters and bytes
 * are the same here. Nothing may spend this cap a second time: `MAX_DRAFT_DOCUMENT_BYTES` below is the
 * only fence, and it is a pure function of this number.
 */
export const MAX_DRAFT_TOKEN_LENGTH =
  MAX_CONFIRMATION_TOKEN_LENGTH + (DRAFT_TOKEN_PREFIX.length - 'rein_proposal_confirm'.length);

/**
 * The same one cap under the name the collect tool imports it by. It is a plain alias of
 * `MAX_DRAFT_TOKEN_LENGTH`, not a second derivation: the issuer's own length check, the document
 * fence below, and the collect tool's schema `maxLength` all resolve to this one number, so they
 * cannot drift apart.
 */
export const COLLECT_TOKEN_CAP = MAX_DRAFT_TOKEN_LENGTH;
/** The collect tool advertises this purpose's cap as it stands; nothing rescales it. */
export const collectTokenCapForSubmitTokenCap = (submitTokenCap: number): number => submitTokenCap;

/** How long a collected draft stays resumable, in milliseconds. */
export const COLLECT_DRAFT_TTL_MS = 60 * 60 * 1000;

/**
 * The fields one draft carries. `proposalId` is not moved by the tool itself; a prepare step may
 * carry one so a collected draft can name the prepared proposal it already produced, and the collect
 * tool only ever reports that identifier back.
 */
export interface DraftPayload {
  proposerContactId: string;
  title: string | null;
  summary: string | null;
  voteType: string | null;
  requestedMinor: number | null;
  currency: string | null;
  approximateWhen: string | null;
}

/** The public, caller-visible half of a collected draft. */
export interface ProposalDraftPreview {
  title: string | null;
  summary: string | null;
  voteType: string | null;
  requestedMinor: number | null;
  currency: string | null;
  /**
   * The proposer's own rough wording of when. It is not a stored field: a caller has to confirm it
   * inside the proposal summary before submit.
   */
  approximateWhen: string | null;
}

export type DraftTokenFailure =
  | 'draft_token_required'
  | 'draft_token_invalid'
  | 'draft_token_expired'
  | 'draft_token_mismatch';

export type ProposalDraftVerification =
  | { ok: true; payload: DraftPayload }
  | { ok: false; reason: DraftTokenFailure };

export type ProposalDraftIssueResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; reason: 'draft_document_too_large'; documentBytes: number };

const DOCUMENT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';
/**
 * Domain separation for the per-draft encryption key. The signing secret is never used as the key
 * itself: HKDF derives a distinct 32-byte key under a fixed salt and label that differ from the ones
 * the confirmation token uses, so the two purposes never share a key.
 */
const KEY_SALT = 'rein.proposal-draft.hkdf-salt-rpd1';
const KEY_LABEL = 'rein.proposal-draft.aes-256-gcm-rpd1';

/**
 * The largest canonical draft document, in UTF-8 bytes, whose token still fits the cap. The cap and
 * the fence are one number derived once, so the token the mint path accepts and the cap the tool
 * schema advertises can never drift apart: `MAX_DRAFT_DOCUMENT_BYTES` is a pure function of
 * `MAX_DRAFT_TOKEN_LENGTH`, and `MAX_DRAFT_TOKEN_LENGTH` is what both the issuer's length check and
 * the schema's `maxLength` use.
 */
export const MAX_DRAFT_DOCUMENT_BYTES = maxDocumentBytesForToken(MAX_DRAFT_TOKEN_LENGTH);

const canonicalDocument = (payload: DraftPayload, proposalId: string | null): string =>
  JSON.stringify({
    v: DOCUMENT_VERSION,
    proposerContactId: payload.proposerContactId,
    title: payload.title,
    summary: payload.summary,
    voteType: payload.voteType,
    requestedMinor: payload.requestedMinor,
    currency: payload.currency,
    approximateWhen: payload.approximateWhen,
    proposalId,
  });

/** The public, caller-visible half of a collected draft. */
export const draftPreview = (payload: DraftPayload): ProposalDraftPreview => ({
  title: payload.title,
  summary: payload.summary,
  voteType: payload.voteType,
  requestedMinor: payload.requestedMinor,
  currency: payload.currency,
  approximateWhen: payload.approximateWhen,
});

/**
 * Derive the one 32-byte AES-256-GCM key for this purpose from the server-only signing secret. The
 * salt and label are this module's own, so the key is unrelated to the confirmation key even though
 * the secret is the same.
 */
const documentKey = (signingKey: string): Buffer =>
  Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(signingKey, 'utf8'),
      Buffer.from(KEY_SALT, 'utf8'),
      Buffer.from(KEY_LABEL, 'utf8'),
      KEY_BYTES,
    ),
  );

/**
 * The additional authenticated data of one token: the token's own envelope. The expiry is inside it,
 * so a token cannot be re-dated; the version is inside it, so one token shape cannot be read as
 * another; and the proposer binding is inside it, so a ciphertext lifted onto another proposer's
 * request fails authentication instead of decrypting.
 */
const envelopeAad = (expiresAt: number, proposerContactId: string): Buffer =>
  Buffer.from(
    `${DRAFT_TOKEN_PREFIX}.${DRAFT_TOKEN_VERSION}.${expiresAt}.${proposerContactId}`,
    'utf8',
  );

/**
 * Mint one draft token that binds this proposer to this exact carried draft until `expiresAt`. The
 * signing key never leaves the process and never appears in the token or in a result. The proposal
 * identifier travels only as an accompanying binding, never as a stored row this module claims.
 */
export function issueProposalDraft(
  payload: DraftPayload,
  proposalId: string | null,
  signingKey: string,
  now: Date,
): ProposalDraftIssueResult {
  const expiresAt = now.getTime() + COLLECT_DRAFT_TTL_MS;
  const document = Buffer.from(canonicalDocument(payload, proposalId), 'utf8');
  if (document.length > MAX_DRAFT_DOCUMENT_BYTES) {
    // Fail closed before minting: a token the schema would refuse is never handed to a caller.
    return { ok: false, reason: 'draft_document_too_large', documentBytes: document.length };
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, documentKey(signingKey), nonce);
  cipher.setAAD(envelopeAad(expiresAt, payload.proposerContactId));
  const ciphertext = Buffer.concat([cipher.update(document), cipher.final()]);
  // Layout: nonce || ciphertext || tag. The tag is what proves the server minted this binding.
  const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
  const token = `${DRAFT_TOKEN_PREFIX}.${DRAFT_TOKEN_VERSION}.${expiresAt}.${sealed}`;
  if (token.length > MAX_DRAFT_TOKEN_LENGTH) {
    // Belt and braces behind the fence: whatever the arithmetic says, a token longer than the one cap
    // the schema advertises is never returned, because the next collect call could not accept it back.
    return { ok: false, reason: 'draft_document_too_large', documentBytes: document.length };
  }
  return { ok: true, token, expiresAt: new Date(expiresAt).toISOString() };
}

const sameBytes = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Accept only a document whose every field is at its declared type and shape. */
const asDraftPayload = (parsed: unknown): DraftPayload | null => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.v !== DOCUMENT_VERSION) return null;
  const proposerContactId = typeof doc.proposerContactId === 'string' ? doc.proposerContactId : null;
  if (!proposerContactId) return null;
  const text = (value: unknown): string | null | undefined =>
    value === null ? null : typeof value === 'string' ? value : undefined;
  const number = (value: unknown): number | null | undefined =>
    value === null ? null : typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  const title = text(doc.title);
  const summary = text(doc.summary);
  const voteType = text(doc.voteType);
  const currency = text(doc.currency);
  const approximateWhen = text(doc.approximateWhen);
  const requestedMinor = number(doc.requestedMinor);
  if (
    title === undefined ||
    summary === undefined ||
    voteType === undefined ||
    currency === undefined ||
    approximateWhen === undefined ||
    requestedMinor === undefined
  ) {
    return null;
  }
  return { proposerContactId, title, summary, voteType, requestedMinor, currency, approximateWhen };
};

/**
 * Read the encrypted document, or null when the token does not authenticate. The proposer binding is
 * part of the additional authenticated data, so this is called with the proposer the caller is now
 * collecting as: another author's ciphertext fails authentication here.
 */
const openDocument = (
  sealed: string,
  expiresAt: number,
  proposerContactId: string,
  signingKey: string,
): { payload: DraftPayload; proposalId: string | null } | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(sealed)) return null;
  const buffer = Buffer.from(sealed, 'base64url');
  // Base64url drops the trailing bits that carry no byte, so one sealed blob has several spellings
  // that decode to exactly the same bytes. Accept only the canonical spelling the mint side produced:
  // a sibling spelling would decode to a valid draft and could stand in for the issued token.
  if (buffer.toString('base64url') !== sealed) return null;
  if (buffer.length <= NONCE_BYTES + TAG_BYTES) return null;
  const nonce = buffer.subarray(0, NONCE_BYTES);
  const ciphertext = buffer.subarray(NONCE_BYTES, buffer.length - TAG_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, documentKey(signingKey), nonce);
    decipher.setAAD(envelopeAad(expiresAt, proposerContactId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A forged, truncated, re-dated, re-aimed or wrongly keyed token fails here and is invalid. A
    // confirmation token opened under this purpose's key fails here too, which is the point.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
  const payload = asDraftPayload(parsed);
  if (payload === null) return null;
  const doc = parsed as Record<string, unknown>;
  const proposalId = doc.proposalId === null || typeof doc.proposalId === 'string' ? (doc.proposalId as string | null) : null;
  return { payload, proposalId };
};

/** Read the envelope out of a token without trusting any of it. */
const readEnvelope = (token: unknown): { expiresAt: number; sealed: string } | null => {
  if (typeof token !== 'string' || !token.trim()) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 4) return null;
  const [prefix, version, expiresText, sealed] = parts;
  if (prefix !== DRAFT_TOKEN_PREFIX || version !== DRAFT_TOKEN_VERSION) return null;
  if (!sealed) return null;
  const expiresAt = Number(expiresText);
  if (!Number.isFinite(expiresAt)) return null;
  return { expiresAt, sealed };
};

/**
 * Verify a carried draft token against the proposer now collecting.
 *
 * Four outcomes are kept apart so a caller can tell an omitted token from an altered one: a missing
 * token, a token the server did not mint (including a submit confirmation, whose prefix differs), a
 * token whose window has passed, and a valid token whose proposer differs from the current one.
 */
export function verifyProposalDraft(
  token: unknown,
  proposerContactId: string,
  signingKey: string,
  now: Date,
): ProposalDraftVerification {
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, reason: 'draft_token_required' };
  }
  const envelope = readEnvelope(token);
  if (envelope === null) return { ok: false, reason: 'draft_token_invalid' };
  // The expiry travels in the clear because the next collect call has to report an expired token as
  // expired; it is authenticated as additional data, so moving it breaks decryption instead.
  if (envelope.expiresAt <= now.getTime()) {
    return { ok: false, reason: 'draft_token_expired' };
  }
  const decoded = openDocument(envelope.sealed, envelope.expiresAt, proposerContactId, signingKey);
  if (decoded === null) return { ok: false, reason: 'draft_token_invalid' };
  // The ciphertext is authenticated under the carrying proposer's own binding, so a token lifted
  // from another author's draft fails here rather than being reported as a field mismatch.
  if (!sameBytes(decoded.payload.proposerContactId, proposerContactId)) {
    return { ok: false, reason: 'draft_token_mismatch' };
  }
  return { ok: true, payload: decoded.payload };
}

/**
 * The proposal identifier a carried draft names, or null. Kept separate from the payload so the
 * collect tool can report the prepared title of the proposal it already produced without treating
 * the identifier as a field the proposer gave.
 */
export function draftProposalId(token: unknown, proposerContactId: string, signingKey: string, now: Date): string | null {
  if (typeof token !== 'string' || !token.trim()) return null;
  const envelope = readEnvelope(token);
  if (envelope === null || envelope.expiresAt <= now.getTime()) return null;
  const decoded = openDocument(envelope.sealed, envelope.expiresAt, proposerContactId, signingKey);
  if (decoded === null) return null;
  if (!sameBytes(decoded.payload.proposerContactId, proposerContactId)) return null;
  return decoded.proposalId;
}
