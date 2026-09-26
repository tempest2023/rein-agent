// Rein-owned, platform-agnostic outbox runner (PRD R17, R27; AC09, AC14, AC17).
//
// This is the single-pass processor between the deterministic activities core and one external
// provider. It contacts no chat or website API itself: the caller injects a provider that can
// look up an outcome by Rein idempotency key and deliver an intent. Everything the runner learns
// is written back through the activities core, so a crash leaves the durable record in one of two
// honest states: `uncertain` (an attempt started, the outcome is unknown and must be looked up
// before another attempt) or `delivered` (the provider receipt is stored).
//
// Boundaries this module enforces on its own, without trusting a prompt or a manifest:
//   - Only kinds in DELIVERABLE_INTENT_KINDS are handed to a provider, and payment-like kinds are
//     refused even when a job somehow already exists in the outbox.
//   - A delivery is refused when the provider is missing, the runner actor lacks the core
//     capabilities, the provider does not declare the audience the intent reaches, or the
//     underlying record is unconfirmed (activity not approved, publication facts not confirmed by
//     the lead, channel consent missing).
//   - `post_article_link` (R27) is a chat-space effect: it is mapped to `chat.event_space`, and it
//     is delivered only for the publication's own registered link intent, once that article is
//     published and the intent carries its canonical URL.
//   - The runner never reports success before a provider receipt exists, and it never forwards
//     core state: the envelope carries the intent payload plus one explicit article-link summary,
//     and payload fields whose names look private (ballots, payment details, contact lists) block
//     the delivery.
//   - Unknown outcomes are queried by operation key before any retry. A retry after a lookup miss
//     happens only when the provider declares strong lookup consistency and `retryOnLookupMiss`
//     is enabled; otherwise the job stays `uncertain` for a human.
//
// Concurrency: one process deduplicates a single pass, including repeated job entries in that
// pass. Across processes, or after a crash, duplicate suppression rests on the provider
// requirement that creation is idempotent by Rein key; the durable `uncertain` marker is what
// makes a crashed attempt recoverable instead of silently repeated.
import { EXTERNAL_INTENT_KINDS } from './activities.ts';

export const OUTBOX_RUNNER_ID = 'rein-outbox-runner';

export const DEFAULT_RUNNER_ACTOR = Object.freeze({ id: 'outbox-runner', kind: 'agent' });

// Capabilities the runner actor must hold on the activities core. `external.retry` also gates
// marking a definitive failure; `external.reconcile` gates the pre-delivery attempt marker.
export const RUNNER_CAPABILITIES = Object.freeze([
  'external.read', 'external.retry', 'external.reconcile', 'external.record_receipt',
]);

// A payment-shaped kind is refused even though the core also blocks it at enqueue time: an older
// writer or a restored backup could still leave one in the outbox.
export const PAYMENT_KIND_PATTERN = /pay|transfer|payout|reimburse|refund|invoice/i;

export const DELIVERABLE_INTENT_KINDS = Object.freeze(
  EXTERNAL_INTENT_KINDS.filter(kind => !PAYMENT_KIND_PATTERN.test(kind)),
);

// Which audience an intent reaches. `publish_article` derives it from the confirmed publication
// channels; a kind listed below falls back to that mapping when the payload names no audience, and
// any other kind must state its audience in the payload.
export const CHANNEL_AUDIENCES = Object.freeze({
  website: 'website.public',
  chat: 'chat.event_space',
  social: 'social.public',
});

export const KIND_AUDIENCES = Object.freeze({
  create_space: ['chat.event_space'],
  invite_collaborator: ['chat.event_space'],
  post_standing_summary: ['chat.event_space'],
  publish_registration_page: ['website.public'],
  send_registration_notice: ['chat.event_space'],
  send_reminder: ['chat.event_space'],
  send_correction_notice: ['chat.event_space'],
  // R27: the published article link is returned into the event's chat space, never to the public
  // website or a private scope.
  post_article_link: ['chat.event_space'],
});

// Board and finance scopes are not reached by an ordinary provider, even when a payload names
// them, unless the provider is explicitly registered as trusted for restricted scopes.
export const RESTRICTED_AUDIENCES = Object.freeze([
  'board.private', 'finance.private', 'hr.private', 'complaint.private',
]);

// Field names that must not leave the core. R17 forbids copying Board discussion, payment
// details and private contact information into channels; this is the deterministic guard.
export const SENSITIVE_PAYLOAD_PATTERN = /(ballot|board|complaint|payment|bank|iban|swift|accountnumber|cardnumber|contactlist|contact|phone|email|address|salary|receiptreference|paidby|reimburse|payout)/i;

/** A provider that refused the request definitively. Any other error is an unknown outcome. */
export class ProviderRejectionError extends Error {
  code = 'provider_rejected';
  definitive = true;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProviderRejectionError';
    this.details = details;
  }
}

function asRecord(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function clone(value: any) { return structuredClone(value); }

function messageOf(error: any) {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitiveRejection(error: any) {
  return error instanceof ProviderRejectionError ||
    error?.definitive === true ||
    error?.code === 'provider_rejected';
}

function errorCode(error: any) {
  return typeof error?.code === 'string' ? error.code : null;
}

/** Field paths in the payload whose names look private. Compared against field names only. */
function sensitiveFields(value: any, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveFields(item, `${path}[${index}]`));
  const record = asRecord(value);
  if (!record) return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(record)) {
    const here = `${path}.${key}`;
    if (SENSITIVE_PAYLOAD_PATTERN.test(key)) found.push(here);
    found.push(...sensitiveFields(item, here));
  }
  return found;
}

function receiptRef(receipt: any) {
  return receipt?.providerRef ?? receipt?.url ?? receipt?.id ?? null;
}

function normalizeLookupResult(result: any) {
  if (result === null || result === undefined) return { found: false, receipt: null, error: null };
  const record = asRecord(result);
  if (!record) return { found: false, receipt: null, error: null };
  if (record.found === false) return { found: false, receipt: null, error: null };
  if (record.found === true) {
    const receipt = asRecord(record.receipt);
    return receipt
      ? { found: true, receipt, error: null }
      : { found: false, receipt: null, error: 'lookup_receipt_missing' };
  }
  // A bare receipt object is also accepted, but only when it identifies a provider record.
  return receiptRef(record)
    ? { found: true, receipt: record, error: null }
    : { found: false, receipt: null, error: 'lookup_shape_unrecognized' };
}

/**
 * Build one pass-oriented outbox runner over the deterministic activities core.
 *
 * options.core       activities core from `createOperationsCore` (required)
 * options.provider   provider adapter; required to deliver anything. It must expose `id`,
 *                    `audiences`, `lookup({ key })` and `deliver(envelope)`, and may declare
 *                    `kinds`, `consistency` ('strong' | 'eventual') and
 *                    `trustedForRestrictedAudiences`.
 * options.actor      actor the runner writes as; needs RUNNER_CAPABILITIES.
 * options.retryOnLookupMiss  default true: retry only after a definitive lookup miss, and only
 *                            when the provider declares strong lookup consistency.
 */
export function createOutboxRunner(options: any = {}) {
  const core = options.core;
  const requiredCoreMethods = [
    'listExternalIntents', 'getExternalIntent', 'snapshot', 'recordExternalReceipt',
    'markExternalIntentUncertain', 'markExternalIntentFailed',
    'reconcileExternalIntent', 'retryExternalIntent',
  ];
  if (!core || requiredCoreMethods.some(name => typeof core[name] !== 'function')) {
    throw new Error(`createOutboxRunner requires the activities core (${requiredCoreMethods.join(', ')})`);
  }
  const actor = options.actor ?? DEFAULT_RUNNER_ACTOR;
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
    throw new Error('createOutboxRunner requires an actor with a non-empty id');
  }

  const provider = options.provider ?? null;
  const retryOnLookupMiss = options.retryOnLookupMiss !== false;

  function providerStatus() {
    if (!provider) return { ready: false, reason: 'provider_not_configured' };
    if (typeof provider.deliver !== 'function') return { ready: false, reason: 'provider_deliver_missing' };
    if (typeof provider.lookup !== 'function') return { ready: false, reason: 'provider_lookup_missing' };
    if (!Array.isArray(provider.audiences) || provider.audiences.length === 0 ||
        provider.audiences.some((audience: any) => typeof audience !== 'string' || !audience.trim())) {
      return { ready: false, reason: 'provider_audiences_not_declared' };
    }
    return { ready: true, reason: null };
  }

  // Capability-checked reads: enumeration and per-job refreshes go through the core, never
  // through a cached copy that another writer's commit could have invalidated.
  function readIntents() {
    return core.listExternalIntents({ actor });
  }

  function freshJob(jobId: string) {
    return core.getExternalIntent({ actor, jobId });
  }

  function audiencesFor(job: any) {
    const payload = asRecord(job.payload) ?? {};
    const declared = typeof payload.audience === 'string' && payload.audience.trim()
      ? [payload.audience.trim()]
      : [];
    if (job.kind === 'publish_article') {
      const channels = Array.isArray(payload.channels) ? payload.channels.map(String) : [];
      const fromChannels = channels.map((channel: string) => (CHANNEL_AUDIENCES as any)[channel]).filter(Boolean);
      return [...new Set([...declared, ...fromChannels])];
    }
    if (declared.length) return declared;
    return [...((KIND_AUDIENCES as any)[job.kind] ?? [])];
  }

  // Deterministic confirmation gate. Reads the authoritative records, never a model claim.
  function confirmationFor(job: any) {
    const state = core.snapshot();
    if (job.kind === 'create_space') {
      const activity = state.activities?.[job.activityId];
      if (!activity) return { ok: false, reason: 'activity_not_found', note: `activity ${job.activityId} does not exist` };
      if (!['approved', 'preparing'].includes(activity.state)) {
        return {
          ok: false,
          reason: 'confirmation_required',
          note: `an event space is created after approval, not in ${activity.state}`,
        };
      }
      return { ok: true, note: `activity ${activity.state}` };
    }
    if (job.kind === 'publish_article') {
      const publicationId = asRecord(job.payload)?.publicationId;
      const publication = publicationId ? state.publications?.[publicationId] : null;
      if (!publication) {
        return { ok: false, reason: 'publication_not_found', note: `publication ${publicationId ?? '?'} does not exist` };
      }
      // The core links a publication to the single intent it registered. A stray or legacy
      // publish intent for the same publication would create a second article; refuse it.
      if (publication.jobId !== job.id) {
        return {
          ok: false,
          reason: 'intent_not_registered_for_publication',
          note: `publication ${publication.id} is linked to ${publication.jobId ?? 'no intent'}, not ${job.id}`,
        };
      }
      if (!publication.factConfirmation?.confirmedAt) {
        return { ok: false, reason: 'confirmation_required', note: 'publication facts are not confirmed by the activity lead' };
      }
      if (typeof publication.title !== 'string' || !publication.title.trim() ||
          typeof publication.body !== 'string' || !publication.body.trim()) {
        return { ok: false, reason: 'publication_content_missing', note: 'a confirmed article needs title and body' };
      }
      const missingConsents = publication.missingConsents ?? [];
      if (missingConsents.length) {
        return { ok: false, reason: 'consent_required', note: 'channel consent is required before publication', missingConsents };
      }
      if (!['ready', 'publishing'].includes(publication.state)) {
        return { ok: false, reason: 'confirmation_required', note: `publication ${publication.state} is not ready for delivery` };
      }
      return { ok: true, note: `facts confirmed by ${publication.factConfirmation.by ?? 'unknown'}` };
    }
    if (job.kind === 'post_article_link') {
      const payload = asRecord(job.payload) ?? {};
      const publicationId = payload.publicationId;
      const publication = publicationId ? state.publications?.[publicationId] : null;
      if (!publication) {
        return { ok: false, reason: 'publication_not_found', note: `publication ${publicationId ?? '?'} does not exist` };
      }
      // The core links a publication to the single link-return intent it registered, so a stray or
      // restored intent for the same article cannot post a second link.
      if (publication.linkJobId !== job.id) {
        return {
          ok: false,
          reason: 'intent_not_registered_for_publication',
          note: `publication ${publication.id} is linked to ${publication.linkJobId ?? 'no link intent'}, not ${job.id}`,
        };
      }
      if (publication.state !== 'published') {
        return { ok: false, reason: 'confirmation_required', note: `a link is returned after publication, not in ${publication.state}` };
      }
      // Only the canonical URL of the published article may leave: an edited or stale payload
      // cannot point the event space at a different address.
      const url = typeof payload.url === 'string' ? payload.url.trim() : '';
      if (!url || url !== publication.url) {
        return {
          ok: false,
          reason: 'publication_link_mismatch',
          note: 'the intent must carry the canonical URL of the published article',
        };
      }
      const space = state.activities?.[job.activityId]?.space;
      if (space?.state !== 'created') {
        return { ok: false, reason: 'event_space_not_created', note: 'there is no event space to return the link to' };
      }
      return { ok: true, note: `link for ${publication.id} returns to ${space.url ?? 'the event space'}` };
    }
    return { ok: true, note: 'no additional confirmation gate for this kind' };
  }

  function guard(job: any) {
    const kind = typeof job.kind === 'string' ? job.kind : '';
    if (PAYMENT_KIND_PATTERN.test(kind)) {
      return {
        ok: false,
        reason: 'payment_not_supported',
        note: `intent ${kind} looks like a payment; this runner never initiates payments`,
      };
    }
    if (!DELIVERABLE_INTENT_KINDS.includes(kind)) {
      return { ok: false, reason: 'unsupported_kind', note: `intent ${kind} is not a deliverable kind`, known: [...DELIVERABLE_INTENT_KINDS] };
    }
    if (Array.isArray(provider.kinds) && !provider.kinds.includes(kind)) {
      return { ok: false, reason: 'provider_kind_not_supported', note: `provider ${provider.id ?? '?'} does not serve ${kind}` };
    }
    const audiences = audiencesFor(job);
    if (!audiences.length) {
      return { ok: false, reason: 'audience_required', note: `intent ${kind} does not declare the audience it reaches` };
    }
    for (const audience of audiences) {
      if (RESTRICTED_AUDIENCES.includes(audience) && provider.trustedForRestrictedAudiences !== true) {
        return { ok: false, reason: 'audience_restricted', audience, note: `${audience} is a private scope this provider is not trusted for` };
      }
      if (!provider.audiences.includes(audience)) {
        return {
          ok: false,
          reason: 'audience_not_allowed',
          audience,
          note: `provider ${provider.id ?? '?'} does not declare audience ${audience}`,
          declaredAudiences: [...provider.audiences],
        };
      }
    }
    const sensitive = sensitiveFields(job.payload);
    if (sensitive.length) {
      return { ok: false, reason: 'payload_contains_sensitive_field', fields: sensitive, note: 'private material is not sent to an external provider' };
    }
    const confirmation = confirmationFor(job);
    if (!confirmation.ok) return confirmation;
    return { ok: true, audiences, note: confirmation.note };
  }

  function envelopeFor(job: any, audiences: string[], attempt: number) {
    // Only an explicit, allowlisted shape leaves this process.
    const payload = asRecord(job.payload) ?? {};
    const publicationId = job.kind === 'publish_article' || job.kind === 'post_article_link'
      ? payload.publicationId
      : null;
    const publication = publicationId ? core.snapshot().publications?.[publicationId] : null;
    return Object.freeze({
      provider: provider.id ?? null,
      key: job.key,
      kind: job.kind,
      activityId: job.activityId,
      audiences: [...audiences],
      audience: audiences[0],
      payload: clone(job.payload ?? null),
      publication: job.kind === 'publish_article' && publication ? {
        id: publication.id,
        title: publication.title,
        body: publication.body,
        channels: [...publication.channels],
        materialIds: [...publication.materialIds],
      } : null,
      // A link-return effect posts the published article's title and canonical URL, never the body.
      link: job.kind === 'post_article_link' && publication ? {
        publicationId: publication.id,
        title: publication.title,
        url: publication.url,
      } : null,
      attempt,
    });
  }

  async function lookupByKey(job: any) {
    try {
      const result = await provider.lookup({
        provider: provider.id ?? null, key: job.key, kind: job.kind, activityId: job.activityId,
      });
      return normalizeLookupResult(result);
    } catch (error) {
      // A failed query proves nothing about the effect; never treat it as absent.
      return { found: false, receipt: null, error: `lookup_failed:${messageOf(error)}` };
    }
  }

  function recordReceipt(job: any, receipt: any, source: string) {
    if (!receiptRef(receipt) ||
        (receipt.key !== undefined && receipt.key !== job.key) ||
        (job.kind === 'publish_article' &&
          (typeof receipt.url !== 'string' || !receipt.url.trim()))) {
      throw new ProviderRejectionError('provider receipt is missing a matching resource reference or publication URL');
    }
    const stored = { ...clone(receipt), provider: provider?.id ?? null, key: job.key, source };
    const outcome = core.recordExternalReceipt({ actor, jobId: job.id, receipt: stored });
    return { outcome, stored };
  }

  function markUncertain(job: any, note: string) {
    const current = freshJob(job.id);
    if (!current || current.state !== 'pending') return;
    core.markExternalIntentUncertain({ actor, jobId: job.id, note });
  }

  async function deliver(job: any, guards: any, { viaRetry = false } = {}) {
    const attempt = (job.attempts ?? 0) + 1;
    // Durable "an attempt is starting and the outcome is unknown". A crash after this point
    // leaves a job that must be looked up instead of blindly delivered again.
    core.markExternalIntentUncertain({ actor, jobId: job.id, note: `outbox-runner started attempt ${attempt} for ${job.key}` });
    let result: any;
    try {
      result = await provider.deliver(envelopeFor(job, guards.audiences, attempt));
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        core.markExternalIntentFailed({ actor, jobId: job.id, error: messageOf(error) });
        return { action: 'failed', reason: 'provider_rejected', note: messageOf(error) };
      }
      return await settleUncertain(job, { reason: 'delivery_error', note: messageOf(error) });
    }
    const receipt = asRecord(result?.receipt);
    if (!receipt) {
      // No receipt means no evidence of an effect: never claim success.
      return await settleUncertain(job, { reason: 'provider_receipt_missing', note: 'provider returned no receipt' });
    }
    const { outcome, stored } = recordReceipt(job, receipt, viaRetry ? 'retried_delivery' : 'delivery');
    return {
      action: viaRetry ? 'retried_delivered' : 'delivered',
      receipt: stored,
      deliveryAttempts: attempt,
      state: outcome?.state ?? 'delivered',
    };
  }

  /**
   * The outcome is unknown. Query by operation key before anything else: a recorded receipt is
   * stored as the truth, a definitive miss may be retried under policy, and everything else stays
   * `uncertain` for a handler.
   */
  async function settleUncertain(job: any, context: any, { viaRetry = false } = {}) {
    const lookup = await lookupByKey(job);
    if (lookup.found) {
      const { stored } = recordReceipt(job, lookup.receipt, 'lookup');
      return {
        action: 'reconciled_delivered',
        reason: context.reason,
        note: 'the provider already holds this operation key',
        receipt: stored,
      };
    }
    const current = freshJob(job.id) ?? job;
    if (lookup.error) {
      markUncertain(current, `outbox-runner lookup for ${job.key} failed: ${lookup.error}`);
      return { action: 'held', reason: 'lookup_failed', note: lookup.error };
    }
    const strongConsistency = provider.consistency === 'strong';
    if (retryOnLookupMiss && strongConsistency && !viaRetry) {
      // The provider is authoritative for this key and reports no record, so the earlier attempt
      // had no effect. Reconcile the ambiguous state away, then retry under the same key.
      if (current.state === 'uncertain') {
        core.reconcileExternalIntent({ actor, jobId: job.id, resolution: 'failed' });
      }
      core.retryExternalIntent({ actor, jobId: job.id });
      const clean = freshJob(job.id) ?? job;
      const guards = guard(clean);
      if (!guards.ok) return { action: 'refused', reason: guards.reason, note: guards.note };
      return await deliver(clean, guards, { viaRetry: true });
    }
    markUncertain(current, `outbox-runner found no provider record for ${job.key}; awaiting reconciliation`);
    return {
      action: 'held',
      reason: 'lookup_miss_held',
      note: strongConsistency
        ? 'no provider record for this key; the next pass recovers it'
        : 'the provider is not authoritative for this key yet; a handler must reconcile before another attempt',
    };
  }

  async function processJob(job: any, seen: Set<string>) {
    const base = {
      jobId: job.id,
      key: job.key,
      kind: job.kind,
      activityId: job.activityId,
      requestedBy: job.requestedBy ?? null,
    };
    if (seen.has(job.id)) {
      return { ...base, action: 'duplicate_in_pass', reason: 'duplicate_job_entry', state: freshJob(job.id)?.state ?? job.state };
    }
    const current = freshJob(job.id) ?? job;
    if (PAYMENT_KIND_PATTERN.test(String(current.kind))) {
      return { ...base, state: current.state, action: 'refused', reason: 'payment_not_supported' };
    }
    if (current.state === 'delivered') {
      return { ...base, state: current.state, action: 'already_delivered', receipt: current.providerReceipt ?? current.receipt ?? null };
    }
    if (current.state === 'uncertain') {
      seen.add(job.id);
      const settled = await settleUncertain(current, { reason: 'uncertain_recovery' });
      return { ...base, state: freshJob(job.id)?.state ?? current.state, ...settled };
    }
    if (current.state === 'failed') {
      return { ...base, state: current.state, action: 'skipped', reason: 'awaiting_retry' };
    }

    const guards = guard(current);
    if (!guards.ok) {
      return { ...base, state: current.state, action: 'refused', reason: guards.reason, note: guards.note, ...guards };
    }
    if (current.state !== 'pending') {
      return { ...base, state: current.state, action: 'refused', reason: 'unknown_state' };
    }
    seen.add(job.id);
    const delivered = await deliver(current, guards);
    return { ...base, state: freshJob(job.id)?.state ?? current.state, ...delivered };
  }

  /**
   * One deterministic pass. `input.jobs` may list job ids or job views; when omitted the pass
   * reads every intent from the core. An unavailable provider, a missing grant or an unconfirmed
   * record is a refusal, not a throw.
   */
  async function processOnce(input: any = {}) {
    const status = providerStatus();
    const report: any = {
      runner: OUTBOX_RUNNER_ID,
      providerId: provider?.id ?? null,
      startedAt: new Date().toISOString(),
      ready: status.ready,
      reason: status.reason,
      scanned: 0,
      results: [],
      delivered: [],
      failed: [],
      refused: [],
      held: [],
      skipped: [],
      externalDelivery: status.ready ? (provider.id ?? 'provider') : 'not_connected',
      note: 'this module contacts no chat or website API; the injected provider performs delivery',
    };

    let candidates: any[];
    try {
      candidates = Array.isArray(input.jobs) && input.jobs.length
        ? input.jobs.map((entry: any) => (typeof entry === 'string' ? freshJob(entry) : entry)).filter(Boolean)
        : readIntents();
    } catch (error) {
      report.ready = false;
      report.reason = errorCode(error) === 'unauthorized' ? 'unauthorized' : `intent_read_failed:${messageOf(error)}`;
      report.finishedAt = new Date().toISOString();
      return report;
    }

    report.scanned = candidates.length;
    if (!status.ready) {
      report.results = candidates.map((job: any) => ({
        jobId: job.id, key: job.key, kind: job.kind, activityId: job.activityId,
        state: job.state, action: 'refused', reason: status.reason,
      }));
      report.refused = report.results.map((result: any) => result.jobId);
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      let result: any;
      try {
        result = await processJob(candidate, seen);
      } catch (error) {
        result = {
          jobId: candidate?.id, key: candidate?.key, kind: candidate?.kind, activityId: candidate?.activityId,
          state: candidate?.id ? (freshJob(candidate.id)?.state ?? candidate.state) : null,
          action: 'error', reason: messageOf(error),
        };
      }
      report.results.push(result);
      if (['delivered', 'retried_delivered', 'reconciled_delivered'].includes(result.action)) {
        report.delivered.push({
          jobId: result.jobId, key: result.key, kind: result.kind,
          activityId: result.activityId, receipt: result.receipt ?? null,
        });
      } else if (result.action === 'failed') report.failed.push(result.jobId);
      else if (result.action === 'refused' || result.action === 'error') report.refused.push(result.jobId);
      else if (result.action === 'held') report.held.push(result.jobId);
      else report.skipped.push(result.jobId);
    }
    report.finishedAt = new Date().toISOString();
    return report;
  }

  return { processOnce, providerStatus, runnerId: OUTBOX_RUNNER_ID, actor: { ...actor } };
}
