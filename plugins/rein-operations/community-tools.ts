import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { BackendRuntime } from './backend-runtime.ts';
import { assertCurrentInvocation } from './request-context.ts';

// PRD R01/R03/R25, US01/US02: current organization resources for linked Community Members.
// The backend authorizes the trusted sender on every call; no cached member flag or model actor.
export const COMMUNITY_TOOL_NAMES = Object.freeze([
  'rein_resources_search', 'rein_resource_get', 'rein_events_search', 'rein_event_get',
]);

const textFilter = () => Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
const uuid = () => Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const instant = () => Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$' });
const nullableText = () => Type.Union([Type.String(), Type.Null()]);
const closedObject = (fields: Record<string, any>) => Type.Object(fields, { additionalProperties: false });
const page = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Results per page; default 3.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: 'Use nextOffset from the previous successful result.' })),
};
const resourcesParameters = closedObject({
  query: Type.Optional(textFilter()), language: Type.Optional(textFilter()), difficulty: Type.Optional(textFilter()),
  topic: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: 'Exact catalog topic tag; omit if unknown.' })),
  resourceType: Type.Optional(Type.Union(['Video', 'Article / Document', 'Course', 'Paper Discussion', 'Tool / Reference'].map(Type.Literal))),
  ...page,
});
const eventsParameters = closedObject({
  query: Type.Optional(textFilter()), city: Type.Optional(textFilter()),
  format: Type.Optional(Type.Union(['online', 'in_person', 'hybrid'].map(Type.Literal))),
  startsAfter: Type.Optional(instant()), startsBefore: Type.Optional(instant()), ...page,
});
const detailParameters = closedObject({ id: uuid() });

const commonItem = {
  id: uuid(), title: Type.String(), summary: Type.String(), url: Type.String(),
  updatedAt: instant(), publicationStatus: Type.Literal('published'),
};
const resourceItem = closedObject({
  ...commonItem, type: Type.String(), language: Type.String(), difficulty: nullableText(),
  topics: Type.Array(Type.String()), authorPublisher: nullableText(), accessNotes: nullableText(),
  verifiedAt: Type.Union([instant(), Type.Null()]),
});
const eventItem = closedObject({
  ...commonItem, body: Type.Optional(nullableText()),
  format: Type.Union(['online', 'in_person', 'hybrid'].map(Type.Literal)), timezone: Type.String(),
  country: nullableText(), region: nullableText(), city: nullableText(), venue: nullableText(),
  registrationStatus: Type.Union(['open', 'waitlist', 'full', 'closed'].map(Type.Literal)),
  registrationUrl: Type.String(), relationship: Type.String(),
  sessions: Type.Array(closedObject({ startsAt: instant(), endsAt: instant() })),
});
const resultSchema = (resources: boolean) => closedObject({
  ok: Type.Literal(true), status: Type.Union(['found', 'empty', 'not_found'].map(Type.Literal)),
  source: Type.Literal('foundation_catalog'), environment: Type.Union([Type.Literal('dev'), Type.Literal('prod')]),
  retrievedAt: instant(), items: Type.Array(resources ? resourceItem : eventItem, { maxItems: 20 }),
  hasMore: Type.Boolean(), nextOffset: Type.Union([Type.Integer({ minimum: 1, maximum: 10020 }), Type.Null()]),
  window: Type.Optional(closedObject({ startsAfter: instant(), startsBefore: Type.Union([instant(), Type.Null()]) })),
});

const safeUrl = (value: string) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};
const validInstant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const reply = (details: Record<string, unknown>) => ({
  ...(details.ok === false ? { isError: true } : {}),
  content: [{ type: 'text' as const, text: JSON.stringify(details) }], details,
});
const failure = (reason: string) => reply({ ok: false, status: 'failed', reason,
  message: reason === 'community_member_required'
    ? 'This lookup failed: the current Discord/Slack account must have a verified Community Member link. Complete or repair the link, then retry.'
    : reason === 'permission_denied'
      ? 'This lookup failed because the current caller or channel is not authorized.'
      : reason === 'invalid_request'
        ? 'This lookup failed because its filters or identifier are invalid.'
        : 'This lookup failed: the organization source or current identity could not be verified. Try again later.',
});

const definitions = [
  { name: 'rein_resources_search', operation: 'community_resources_search', parameters: resourcesParameters, resources: true, detail: false,
    description: 'Search the Foundation website published resource catalog for the CURRENT linked Community Member. Query matches title/summary; language and difficulty match catalog text. Returns canonical links, source timestamps and pagination. No web search or memory fallback; every call rechecks membership. Unknown fees, course duration or prerequisites must not be invented.' },
  { name: 'rein_resource_get', operation: 'community_resource_get', parameters: detailParameters, resources: true, detail: true,
    description: 'Read one currently published Foundation resource by the record ID returned from rein_resources_search. Rechecks current Community Member link and publication; not_found also covers withdrawn/unpublished records.' },
  { name: 'rein_events_search', operation: 'community_events_search', parameters: eventsParameters, resources: false, detail: false,
    description: 'Search official published Foundation events for the CURRENT linked Community Member. Defaults to sessions starting from backend current time; startsBefore is exclusive. Uses city, format and title/summary filters. Returns matching sessions, IANA timezone and recorded registration status. Pages are newest-created first, not soonest-first; cancelled/unpublished events are excluded. No registration is performed.' },
  { name: 'rein_event_get', operation: 'community_event_get', parameters: detailParameters, resources: false, detail: true,
    description: 'Recheck one published Foundation event by record ID, including all sessions and current recorded registration status. Requires the CURRENT Community Member link. not_found includes cancelled/unpublished events; it is not evidence that registration succeeded.' },
];

export function createCommunityToolsRegistration({ runtime }: { runtime: BackendRuntime }) {
  const wrapped = runtime.wrapRegistration({
    contextVersion: 2 as const,
    create(ctx: unknown) {
      return definitions.map(definition => ({
        name: definition.name, description: definition.description, parameters: definition.parameters,
        async execute(_callId: string, args: unknown) {
          assertCurrentInvocation(ctx);
          if (!Check(definition.parameters, args)) return failure('invalid_request');
          const input = args as Record<string, unknown>;
          for (const key of ['startsAfter', 'startsBefore']) {
            if (input[key] !== undefined && !validInstant(input[key])) return failure('invalid_request');
          }
          const proof = runtime.proofProvider(ctx);
          if (!proof?.ok) return failure('unavailable');
          const response = await runtime.transport.operations(definition.operation, input, proof.proof);
          assertCurrentInvocation(ctx);
          if (!response.ok) {
            if (['binding_not_verified', 'identity_revoked'].includes(response.refusalReason ?? '')) return failure('community_member_required');
            if (response.reason === 'auth_error') return failure('permission_denied');
            if (response.refusalReason === 'invalid_request') return failure('invalid_request');
            return failure('unavailable');
          }
          const body = response.body;
          if (!object(body) || body.ok !== true || body.operation !== definition.operation) return failure('unavailable');
          const result = body.result;
          if (!Check(resultSchema(definition.resources), result) || !object(result)) return failure('unavailable');
          const items = result.items as Record<string, any>[];
          if (!validInstant(result.retrievedAt) || (items.length > 0) !== (result.status === 'found') ||
              result.hasMore !== (result.nextOffset !== null) || (definition.detail && (items.length > 1 || result.hasMore || result.status === 'empty')) ||
              (!definition.detail && result.status === 'not_found')) return failure('unavailable');
          if ((definition.detail && items.some(item => item.id.toLowerCase() !== String(input.id).toLowerCase())) ||
              (!definition.detail && items.length > Number(input.limit ?? 3))) return failure('unavailable');
          for (const item of items) {
            if (!safeUrl(item.url) || !validInstant(item.updatedAt)) return failure('unavailable');
            if (definition.resources) {
              if (item.verifiedAt !== null && !validInstant(item.verifiedAt)) return failure('unavailable');
            } else {
              if (!safeUrl(item.registrationUrl)) return failure('unavailable');
              try { new Intl.DateTimeFormat('en', { timeZone: item.timezone }); } catch { return failure('unavailable'); }
              if (item.sessions.some((s: Record<string, string>) => !validInstant(s.startsAt) || !validInstant(s.endsAt) ||
                Date.parse(s.endsAt) <= Date.parse(s.startsAt))) return failure('unavailable');
            }
          }
          // Strict schema: no backend identity, credential, admin metadata or arbitrary extra field is exposed.
          return reply(result);
        },
      }));
    },
  });
  return {
    contextVersion: 2 as const,
    create(ctx: unknown) {
      return wrapped.create(ctx).map(tool => ({
        ...tool,
        async execute(callId: string, args: unknown) {
          try { return await tool.execute(callId, args); }
          catch { return failure('unavailable'); }
        },
      }));
    },
  };
}
