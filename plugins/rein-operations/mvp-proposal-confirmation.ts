// Verifiable author confirmation for the MVP proposal write path.
//
// PRD §2.3 step 2 and `workspace/AGENTS.md` require that a stored proposal is the version its
// author confirmed. The MVP proposal table has no draft status or confirmation column, so the
// confirmation cannot be a stored draft row. Instead the prepare step mints a short-lived token
// that binds one proposer to one exact payload, and the submit step refuses to write until it
// receives that token back together with an explicit confirmation statement.
//
// Confidentiality. The token travels back through the model and the chat transcript, so the payload
// it carries must not be readable there. The token is an AES-256-GCM ciphertext of the canonical
// payload document: the proposer's own request text and their private contact identifier never
// appear in the clear. One key is derived per purpose from the server-only confirmation signing
// secret with HKDF-SHA256 under an explicit domain separation label, and the expiry, the token
// version and the proposer binding are authenticated as additional data, so a token cannot be
// re-aimed at another proposer, another binding or another window without failing authentication.
//
// Verification re-derives the payload from the submitted arguments, so altering the title, the type,
// the amount or the currency after the preview invalidates the token. The token carries no
// credential of its own: the ciphertext protects the content, and the GCM tag only proves the server
// minted this exact binding.
//
// Replay: a token is bound to the proposer and the payload, and the identifier that becomes the
// proposal row's primary key is derived from that same binding. Submitting the same confirmed
// payload twice therefore addresses the same database row: the first write inserts it and the second
// is reported as the same record, so a retry cannot create a second proposal. A token is
// short-lived and expiry is enforced against the injected clock.
//
// Size. Encryption does not compress: the ciphertext is the UTF-8 document plus a fixed header and
// one 16-byte tag, base64url-encoded. The document fence, the token cap and the envelope width are
// tied together by `maxDocumentBytesForToken`, so the fence can never admit a document whose token
// would exceed the cap the schema advertises. A document over the fence, or one whose minted token
// would still exceed the cap, is refused before a token is handed out rather than emitted unusable.
//
// Migration. Tokens minted by the previous HMAC-only shape (`rpc1`) carried the payload in the
// clear and are not accepted here. The TTL is short, so a proposer whose token predates this change
// simply prepares the proposal again and reads the prepared text back once more.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const CONFIRMATION_TOKEN_VERSION = 'rpc2';
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

export type ConfirmationIssueResult =
  | { ok: true; token: string; expiresAt: string; proposalId: string }
  | { ok: false; reason: 'proposal_confirmation_payload_too_large'; documentBytes: number };

const DOCUMENT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';
/**
 * Domain separation for the per-token encryption key. The signing secret is never used as the key
 * itself: HKDF derives a distinct 32-byte key for this one purpose under a fixed salt and label.
 */
const KEY_SALT = 'rein.proposal-confirmation.hkdf-salt-rpc2';
const KEY_LABEL = 'rein.proposal-confirmation.aes-256-gcm-rpc2';

/**
 * The largest confirmation token the tool contract accepts, and therefore the schema's own cap. The
 * schema counts characters, and the token is ASCII once base64url-encoded, so characters and bytes
 * are the same here. The cap is a measured bound for the longest legal payload in the widest
 * encoding plus a deliberate margin, not a guess.
 */
export const MAX_CONFIRMATION_TOKEN_LENGTH = 65400;

/** Bytes of envelope that travel before the sealed blob: `prefix.version.expiry.` plus its dots. */
const ENVELOPE_PREFIX_LENGTH = CONFIRMATION_TOKEN_PREFIX.length + CONFIRMATION_TOKEN_VERSION.length + 18;

/**
 * The largest canonical document, in UTF-8 bytes, whose token still fits the cap. The sealed blob is
 * `nonce || ciphertext || tag` and base64url expands 3 bytes to 4 characters, so a document that
 * exactly fills the fence can add a 4-character group the fence did not count. The fence therefore
 * keeps that group inside the cap instead of assuming the last partial group costs nothing.
 */
export const maxDocumentBytesForToken = (tokenCap: number): number => {
  const budget = tokenCap - ENVELOPE_PREFIX_LENGTH - 3;
  return Math.floor((budget * 3) / 4) - NONCE_BYTES - TAG_BYTES;
};

/** The fence the mint path enforces, derived from the same cap the schema advertises. */
export const MAX_CONFIRMATION_DOCUMENT_BYTES = maxDocumentBytesForToken(MAX_CONFIRMATION_TOKEN_LENGTH);

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

/** Derive the one 32-byte AES-256-GCM key for this purpose from the server-only signing secret. */
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
 * The additional authenticated data of one token: the token's own envelope. The expiry is inside
 * it, so a token cannot be re-dated; the version is inside it, so one token shape cannot be read as
 * another; and the proposer binding is inside it, so a ciphertext lifted onto another proposer's
 * request fails authentication instead of decrypting.
 */
const envelopeAad = (expiresAt: number, proposerContactId: string): Buffer =>
  Buffer.from(
    `${CONFIRMATION_TOKEN_PREFIX}.${CONFIRMATION_TOKEN_VERSION}.${expiresAt}.${proposerContactId}`,
    'utf8',
  );

/**
 * Mint one confirmation token that binds this proposer to this exact payload until `expiresAt`.
 * The signing key never leaves the process and never appears in the token or in a result.
 */
export function issueProposalConfirmation(
  payload: ConfirmationPayload,
  signingKey: string,
  now: Date,
): ConfirmationIssueResult {
  const expiresAt = now.getTime() + CONFIRMATION_TTL_MS;
  const document = Buffer.from(canonicalDocument(payload), 'utf8');
  if (document.length > MAX_CONFIRMATION_DOCUMENT_BYTES) {
    // Fail closed before minting: a token the schema would refuse is never handed to a caller.
    return { ok: false, reason: 'proposal_confirmation_payload_too_large', documentBytes: document.length };
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, documentKey(signingKey), nonce);
  cipher.setAAD(envelopeAad(expiresAt, payload.proposerContactId));
  const ciphertext = Buffer.concat([cipher.update(document), cipher.final()]);
  // Layout: nonce || ciphertext || tag. The tag is what proves the server minted this binding.
  const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
  const token = `${CONFIRMATION_TOKEN_PREFIX}.${CONFIRMATION_TOKEN_VERSION}.${expiresAt}.${sealed}`;
  if (token.length > MAX_CONFIRMATION_TOKEN_LENGTH) {
    // Belt and braces behind the fence: whatever the arithmetic says, a token longer than the
    // advertised cap is never returned, because the confirm side could not accept it back.
    return { ok: false, reason: 'proposal_confirmation_payload_too_large', documentBytes: document.length };
  }
  return {
    ok: true,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    proposalId: proposalIdForConfirmation(payload, signingKey),
  };
}

const sameBytes = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Accept only a document whose every field is at its declared type and shape. */
const asConfirmationPayload = (parsed: unknown): ConfirmationPayload | null => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
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
 * Read the encrypted document, or null when the token does not authenticate. The proposer binding is
 * part of the additional authenticated data, so this is called with the proposer the caller is
 * currently submitting as: another author's ciphertext fails authentication here.
 */
const openDocument = (
  sealed: string,
  expiresAt: number,
  proposerContactId: string,
  signingKey: string,
): ConfirmationPayload | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(sealed)) return null;
  const buffer = Buffer.from(sealed, 'base64url');
  // Base64url drops the trailing bits that carry no byte, so one sealed blob has several spellings
  // that decode to exactly the same bytes. Accept only the canonical spelling the mint side produced:
  // a sibling spelling would decode to a valid document and could stand in for the issued token.
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
    // A forged, truncated, re-dated, re-aimed or wrongly keyed token fails here and is invalid.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
  return asConfirmationPayload(parsed);
};

/** Read the envelope out of a token without trusting any of it. */
const readEnvelope = (token: unknown): { expiresAt: number; sealed: string } | null => {
  if (typeof token !== 'string' || !token.trim()) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 4) return null;
  const [prefix, version, expiresText, sealed] = parts;
  if (prefix !== CONFIRMATION_TOKEN_PREFIX || version !== CONFIRMATION_TOKEN_VERSION) return null;
  if (!sealed) return null;
  const expiresAt = Number(expiresText);
  if (!Number.isFinite(expiresAt)) return null;
  return { expiresAt, sealed };
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
  const envelope = readEnvelope(token);
  if (envelope === null) return { ok: false, reason: 'proposal_confirmation_invalid' };
  // The expiry travels in the clear because the confirm phase has to report an expired token as
  // expired; it is authenticated as additional data, so moving it breaks decryption instead of
  // granting a longer window.
  if (envelope.expiresAt <= now.getTime()) {
    return { ok: false, reason: 'proposal_confirmation_expired' };
  }
  const decoded = openDocument(envelope.sealed, envelope.expiresAt, payload.proposerContactId, signingKey);
  if (decoded === null) return { ok: false, reason: 'proposal_confirmation_invalid' };
  // The ciphertext is authenticated under the submitting proposer's own binding, so a token lifted
  // from another author's request fails here rather than being reported as a field mismatch.
  if (!sameBytes(decoded.proposerContactId, payload.proposerContactId)) {
    return { ok: false, reason: 'proposal_confirmation_invalid' };
  }
  if (canonicalDocument(decoded) !== canonicalDocument(payload)) {
    return { ok: false, reason: 'proposal_confirmation_mismatch' };
  }
  return { ok: true, payload: decoded };
}
