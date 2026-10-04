import { Type } from 'typebox';
import { isBackendProof } from './backend-transport.ts';
import type { BackendRuntime, ToolProofProvider } from './backend-runtime.ts';

export const IDENTITY_BIND_TOOL_NAMES = Object.freeze([
  'rein_identity_bind_start',
  'rein_identity_bind_status',
  'rein_identity_bind_complete',
] as const);

export interface IdentityToolsOptions {
  runtime: BackendRuntime;
  proofProvider?: ToolProofProvider;
}

export interface IdentityToolsRegistration {
  contextVersion: 2;
  create(ctx: unknown): unknown[] | null;
}

const MAX_BINDING_CODE_LENGTH = 512;
const MAX_LINK_SESSION_ID_LENGTH = 256;
const LINK_STATES = new Set([
  'awaiting_email',
  'email_verified',
  'registration_required',
  'completed',
  'cancelled',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
 typeof value === 'object' && value !== null && !Array.isArray(value);

/** A present optional string, or null. Never turns a non-string into a claimed value. */
const optionalString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** A URL a person can actually open; anything else is not a usable verification link. */
const isOpenableUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * The transport already refuses non-2xx, but a 200 whose body denies the action or omits the tuple
 * would otherwise read as success. Every bind answer is admitted only on its own envelope: `ok:
 * true` plus the fields that make the outcome usable, so a malformed or refusing 200 never reports
 * a started bind or a recorded binding. The actor contact is deliberately not required here: it is
 * derived by the backend and stays out of the model-visible result.
 */
const readBindStartBody = (body: unknown): { status: string; sessionId: string; verificationUrl: string; expiresAt: string | null } | null => {
  if (!isPlainObject(body) || body.ok !== true) return null;
  const sessionId = optionalString(body.session_id);
  const verificationUrl = optionalString(body.verification_url);
  if (!sessionId || !verificationUrl || !isOpenableUrl(verificationUrl)) return null;
  return {
    status: optionalString(body.status) ?? 'started',
    sessionId,
    verificationUrl,
    expiresAt: optionalString(body.expires_at),
  };
};

const readBindCompleteBody = (body: unknown): { status: string; linkId: string; contactId: string } | null => {
  if (!isPlainObject(body) || body.ok !== true) return null;
  const linkId = optionalString(body.link_id);
  const contactId = optionalString(body.contact_id);
  if (!linkId || !contactId) return null;
  return { status: optionalString(body.status) ?? 'completed', linkId, contactId };
};

const readBindStatusBody = (
  body: unknown,
): { state: string; linked: boolean; expiresAt: string | null } | null => {
  if (!isPlainObject(body) || body.ok !== true) return null;
  const state = optionalString(body.state);
  if (!state || !LINK_STATES.has(state) || typeof body.linked !== 'boolean') return null;
  if (body.linked !== (state === 'completed')) return null;
  return { state, linked: body.linked, expiresAt: optionalString(body.expires_at) };
};

const closed = (details: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(details) }],
  details,
});

const resolveProof = (provider: ToolProofProvider, ctx: unknown) => {
  const resolution = provider(ctx);
  if (!resolution || resolution.ok !== true || !isBackendProof(resolution.proof)) {
    return null;
  }
  return resolution.proof;
};

export const IDENTITY_BIND_CLOSED_REASON = 'identity_binding_unavailable';

function readBindingCode(args: unknown): string | null {
  if (!isPlainObject(args)) return null;
  const code = typeof args.bindingCode === 'string' ? args.bindingCode.trim() : '';
  if (!code || code.length > MAX_BINDING_CODE_LENGTH) return null;
  return code;
}

function readSessionId(args: unknown): string | null {
  if (!isPlainObject(args)) return null;
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!sessionId || sessionId.length > MAX_LINK_SESSION_ID_LENGTH) return null;
  return sessionId;
}

export function createIdentityToolsRegistration(options: IdentityToolsOptions): IdentityToolsRegistration {
  const runtime = options?.runtime;
  if (!runtime || typeof runtime.proofProvider !== 'function') {
    throw new Error('identity tools require a backend runtime');
  }
  const provider = options.proofProvider ?? runtime.proofProvider;

  const buildTools = (ctx: unknown) => {
    const start = {
      name: 'rein_identity_bind_start',
      description:
        'Begin binding the current chat account to a community record. Returns a website URL the person opens in a browser plus a short expiry. It does not confirm anything and does not accept an email address or any other claimed identity: the acting account comes only from the host context, and the backend decides who may bind.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const proof = resolveProof(provider, ctx);
        if (!proof) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: IDENTITY_BIND_CLOSED_REASON,
            recorded: false,
          };
          return closed(details);
        }
        const response = await runtime.transport.linkStart(proof);
        if (!response.ok) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: response.reason,
            httpStatus: response.httpStatus,
            recorded: false,
          };
          return closed(details);
        }
        const started = readBindStartBody(response.body);
        if (!started) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: 'binding_start_malformed',
            httpStatus: response.httpStatus,
            recorded: false,
          };
          return closed(details);
        }
        const details = {
          ok: true,
          status: started.status,
          sessionId: started.sessionId,
          verificationUrl: started.verificationUrl,
          expiresAt: started.expiresAt,
          recorded: false,
          authorizesSpending: false,
        };
        return closed(details);
      },
    };

    const complete = {
      name: 'rein_identity_bind_complete',
      description:
        'Finish binding the current chat account to a community record with the short code the person carried back from the website. The code is the only argument; there is no email, contact or user id argument, and the acting account comes only from the host context.',
      parameters: Type.Object(
        {
          bindingCode: Type.String({
            maxLength: MAX_BINDING_CODE_LENGTH,
            description: 'The short code the website displayed to the person.',
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: unknown) {
        const code = readBindingCode(args);
        if (!code) {
          const details = {
            ok: false,
            status: 'invalid_request',
            reason: 'binding_code_invalid',
            recorded: false,
          };
          return closed(details);
        }
        const proof = resolveProof(provider, ctx);
        if (!proof) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: IDENTITY_BIND_CLOSED_REASON,
            recorded: false,
          };
          return closed(details);
        }
        const response = await runtime.transport.linkComplete(code, proof);
        if (!response.ok) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: response.reason,
            httpStatus: response.httpStatus,
            recorded: false,
          };
          return closed(details);
        }
        const completed = readBindCompleteBody(response.body);
        if (!completed) {
          const details = {
            ok: false,
            status: 'unavailable',
            reason: 'binding_completion_malformed',
            httpStatus: response.httpStatus,
            recorded: false,
          };
          return closed(details);
        }
        const details = {
          ok: true,
          status: completed.status,
          // The bounded link and contact identifiers prove the binding was recorded without
          // naming a person: the backend keeps the contact, and no email or claimed identity is
          // ever accepted or echoed here.
          linkId: completed.linkId,
          recorded: true,
          authorizesSpending: false,
        };
        return closed(details);
      },
    };

    const status = {
      name: 'rein_identity_bind_status',
      description:
        'Check the authoritative backend state of a binding session previously started for the current chat account. Use this after the person returns from the website without a binding code. The session id is the only argument; the backend binds it to the current platform account and never returns an email address.',
      parameters: Type.Object(
        {
          sessionId: Type.String({
            maxLength: MAX_LINK_SESSION_ID_LENGTH,
            description: 'The session id returned by rein_identity_bind_start.',
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: unknown) {
        const sessionId = readSessionId(args);
        if (!sessionId) {
          return closed({
            ok: false,
            status: 'invalid_request',
            reason: 'binding_session_invalid',
            recorded: false,
          });
        }
        const proof = resolveProof(provider, ctx);
        if (!proof) {
          return closed({
            ok: false,
            status: 'unavailable',
            reason: IDENTITY_BIND_CLOSED_REASON,
            recorded: false,
          });
        }
        const response = await runtime.transport.linkStatus(sessionId, proof);
        if (!response.ok) {
          return closed({
            ok: false,
            status: 'unavailable',
            reason: response.reason,
            httpStatus: response.httpStatus,
            recorded: false,
          });
        }
        const current = readBindStatusBody(response.body);
        if (!current) {
          return closed({
            ok: false,
            status: 'unavailable',
            reason: 'binding_status_malformed',
            httpStatus: response.httpStatus,
            recorded: false,
          });
        }
        const registrationRequired = current.state === 'registration_required';
        return closed({
          ok: true,
          status: current.state,
          linked: current.linked,
          expiresAt: current.expiresAt,
          registrationRequired,
          nextStep: registrationRequired ? 'contact_administrator_to_register' : null,
          message: registrationRequired
            ? 'This verified email is not registered with the Rein community. Contact an administrator to register before linking this chat account.'
            : null,
          recorded: false,
          authorizesSpending: false,
        });
      },
    };

    return [start, status, complete];
  };

  return {
    contextVersion: 2 as const,
    create(ctx: unknown) {
      return buildTools(ctx);
    },
  };
}
