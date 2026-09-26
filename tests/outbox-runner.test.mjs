import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOperationsCore,
  createCapabilityAuthorizer,
  CAPABILITIES,
} from '../plugins/rein-operations/activities.ts';
import {
  createOutboxRunner,
  ProviderRejectionError,
  RUNNER_CAPABILITIES,
  DELIVERABLE_INTENT_KINDS,
} from '../plugins/rein-operations/outbox-runner.ts';

const ADMIN = { id: 'admin-1', kind: 'human' };
const LEAD = { id: 'lead-1', kind: 'human' };
const RUNNER = { id: 'outbox-runner-1', kind: 'agent' };
const NOW = '2026-09-24T10:00:00.000Z';

function grantsFor(actor, capabilities = CAPABILITIES) {
  return capabilities.map(capability => ({ actorId: actor.id, capability }));
}

function harness({ state = null, runnerGrants = true } = {}) {
  const authorizer = createCapabilityAuthorizer([
    ...grantsFor(ADMIN),
    ...grantsFor(LEAD),
    ...(runnerGrants ? grantsFor(RUNNER, RUNNER_CAPABILITIES) : []),
  ]);
  return createOperationsCore({
    now: () => NOW,
    authorize: authorizer,
    verifyContributor: memberId => memberId === LEAD.id,
    store: state ? { load: () => structuredClone(state), save: () => {} } : undefined,
  });
}

// A second core over an existing state stands in for a process that restarted.
function reseed(core, jobs) {
  const state = core.snapshot();
  for (const job of jobs) {
    state.jobs[job.id] = {
      attempts: 0, createdAt: NOW, updatedAt: NOW, receipt: null, note: null,
      payload: null, requestedBy: 'earlier-writer', ...job,
    };
    state.jobKeys[job.key] = job.id;
  }
  return harness({ state });
}

function approvedActivity(core) {
  const activity = core.createActivity({ actor: ADMIN, title: 'Community workshop', eventType: 'workshop', leadId: LEAD.id });
  core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'confirmed' });
  core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'evaluating' });
  core.transitionActivity({
    actor: ADMIN, activityId: activity.id, to: 'approved',
    basis: 'zero_budget_fast_track', reference: 'fast-track-2026-09-24',
  });
  return activity.id;
}

function completedActivity(core) {
  const activityId = approvedActivity(core);
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  return activityId;
}

// An approved, completed activity whose article is published and whose event space exists, so the
// core has already queued the `post_article_link` intent for the chat space (R27).
function publishedArticle(core) {
  const activityId = approvedActivity(core);
  const { job: spaceJob } = core.requestActivitySpace({ actor: ADMIN, activityId });
  core.recordExternalReceipt({
    actor: ADMIN, jobId: spaceJob.id,
    receipt: { providerRef: 'space-1', url: 'https://chat.example.org/spaces/1' },
  });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  const publication = core.createPublicationDraft({
    actor: ADMIN, activityId, title: 'Workshop recap', body: 'What happened.', channels: ['website'],
  });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: publication.id });
  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: publication.id }).confirmed, true);
  const published = core.publishPublication({ actor: ADMIN, publicationId: publication.id });
  core.recordExternalReceipt({
    actor: ADMIN, jobId: published.job.id,
    receipt: { providerRef: 'site-9', url: 'https://example.org/articles/9' },
  });
  const linkJob = core.listExternalIntents({ actor: ADMIN, activityId })
    .find(job => job.kind === 'post_article_link');
  return { activityId, publicationId: publication.id, publishJobId: published.job.id, linkJob };
}

function fakeProvider(overrides = {}) {
  const calls = { deliver: 0, lookup: 0, deliveryKeys: [] };
  const provider = {
    id: overrides.id ?? 'fake-website',
    audiences: overrides.audiences ?? ['chat.event_space', 'website.public', 'social.public'],
    consistency: overrides.consistency ?? 'strong',
    async deliver(envelope) {
      calls.deliver += 1;
      calls.deliveryKeys.push(envelope.key);
      if (overrides.deliver) return overrides.deliver(envelope, calls);
      return { receipt: { providerRef: 'site-1', url: 'https://example.org/events/1' } };
    },
    async lookup(request) {
      calls.lookup += 1;
      return overrides.lookup ? overrides.lookup(request, calls) : null;
    },
  };
  if (overrides.kinds) provider.kinds = overrides.kinds;
  if (overrides.trustedForRestrictedAudiences) provider.trustedForRestrictedAudiences = true;
  return { provider, calls };
}

function intentOf(core, jobId) {
  return core.listExternalIntents({ actor: ADMIN }).find(job => job.id === jobId);
}

test('an approved event space is delivered once and the provider receipt is stored', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  assert.equal(core.getExternalIntent({ actor: RUNNER, jobId: job.id }).id, job.id);
  assert.throws(() => core.listAuditEvents({ actor: RUNNER }), error => error.code === 'unauthorized');
  const { provider, calls } = fakeProvider();
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(report.ready, true);
  assert.equal(report.scanned, 1);
  assert.equal(calls.deliver, 1);
  assert.deepEqual([...new Set(calls.deliveryKeys)], [job.key]);
  assert.deepEqual(report.delivered.map(entry => entry.jobId), [job.id]);
  assert.equal(report.results[0].action, 'delivered');

  const intent = intentOf(core, job.id);
  assert.equal(intent.state, 'delivered');
  assert.equal(intent.receipt.providerRef, 'site-1');
  assert.equal(intent.receipt.provider, 'fake-website');
  assert.equal(intent.receipt.key, job.key);
  assert.equal(intent.receipt.recordedBy, RUNNER.id);
  assert.equal(core.getActivity(activityId).space.state, 'created');
  assert.equal(core.getActivity(activityId).space.url, 'https://example.org/events/1');

  const second = await runner.processOnce();
  assert.equal(calls.deliver, 1);
  assert.equal(second.results[0].action, 'already_delivered');
  assert.deepEqual(second.delivered, []);
});

test('a timed-out delivery is reconciled from the existing provider receipt, never re-sent', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  const { provider, calls } = fakeProvider({
    deliver: () => { throw new Error('ETIMEDOUT'); },
    lookup: () => ({ found: true, receipt: { providerRef: 'existing-space-7', url: 'https://example.org/events/7' } }),
  });
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(calls.deliver, 1);
  assert.equal(calls.lookup, 1);
  assert.equal(report.results[0].action, 'reconciled_delivered');

  const intent = intentOf(core, job.id);
  assert.equal(intent.state, 'delivered');
  assert.equal(intent.receipt.providerRef, 'existing-space-7');
  assert.equal(intent.receipt.source, 'lookup');
  assert.equal(core.getActivity(activityId).space.state, 'created');
  assert.equal(core.getActivity(activityId).space.url, 'https://example.org/events/7');
});

test('a definitive lookup miss with a strongly consistent provider retries under the same key', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  let attempt = 0;
  const { provider, calls } = fakeProvider({
    consistency: 'strong',
    deliver: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('socket hang up');
      return { receipt: { providerRef: 'second-attempt', url: 'https://example.org/events/second' } };
    },
    lookup: () => null,
  });
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(report.results[0].action, 'retried_delivered');
  assert.equal(calls.deliver, 2);
  assert.equal(calls.lookup, 1);
  assert.deepEqual([...new Set(calls.deliveryKeys)], [job.key]);
  const intent = intentOf(core, job.id);
  assert.equal(intent.state, 'delivered');
  assert.equal(intent.receipt.providerRef, 'second-attempt');
  assert.equal(core.getActivity(activityId).space.state, 'created');
});

test('a lookup miss on an eventually consistent provider holds the intent as uncertain', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  const { provider, calls } = fakeProvider({
    consistency: 'eventual',
    deliver: () => { throw new Error('read ECONNRESET'); },
    lookup: () => null,
  });
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(report.results[0].action, 'held');
  assert.equal(report.results[0].reason, 'lookup_miss_held');
  assert.equal(calls.deliver, 1);
  assert.equal(calls.lookup, 1);
  const intent = intentOf(core, job.id);
  assert.equal(intent.state, 'uncertain');
  assert.deepEqual(report.delivered, []);
  assert.equal(core.getActivity(activityId).space.state, 'pending');
});

test('repeat passes and duplicate job entries in one pass do not deliver twice', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  const { provider, calls } = fakeProvider();
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce({ jobs: [job.id, job.id, intentOf(core, job.id)] });
  assert.equal(calls.deliver, 1);
  assert.equal(report.delivered.length, 1);
  assert.deepEqual(report.results.map(result => result.action), ['delivered', 'duplicate_in_pass', 'duplicate_in_pass']);

  await runner.processOnce();
  await runner.processOnce();
  assert.equal(calls.deliver, 1);
  assert.equal(intentOf(core, job.id).state, 'delivered');
});

test('a payment-shaped intent that reaches the outbox is refused, not delivered', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const seeded = reseed(core, [{
    id: 'job-900', key: 'payout:activity-1', kind: 'payout_vendor', activityId,
    payload: { amountMinor: 500000, currency: 'USD' }, state: 'pending',
  }]);
  const { provider, calls } = fakeProvider();
  const runner = createOutboxRunner({ core: seeded, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(report.results[0].action, 'refused');
  assert.equal(report.results[0].reason, 'payment_not_supported');
  assert.equal(calls.deliver, 0);
  assert.equal(calls.lookup, 0);
  assert.equal(intentOf(seeded, 'job-900').state, 'pending');
  assert.equal(DELIVERABLE_INTENT_KINDS.includes('payout_vendor'), false);
});

test('a missing provider, a missing grant or an undeclared audience refuses delivery', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });

  const noProvider = await createOutboxRunner({ core, actor: RUNNER }).processOnce();
  assert.equal(noProvider.ready, false);
  assert.equal(noProvider.reason, 'provider_not_configured');
  assert.equal(noProvider.externalDelivery, 'not_connected');
  assert.equal(noProvider.results[0].reason, 'provider_not_configured');

  const unprivileged = harness({ runnerGrants: false });
  const unprivilegedActivity = approvedActivity(unprivileged);
  const { job: unprivilegedJob } = unprivileged.requestActivitySpace({ actor: ADMIN, activityId: unprivilegedActivity });
  const { provider: fullProvider, calls: unprivilegedCalls } = fakeProvider();
  const denied = await createOutboxRunner({ core: unprivileged, provider: fullProvider, actor: RUNNER }).processOnce();
  assert.equal(denied.ready, false);
  assert.equal(denied.reason, 'unauthorized');
  assert.equal(unprivilegedCalls.deliver, 0);
  assert.equal(intentOf(unprivileged, unprivilegedJob.id).state, 'pending');

  const { provider: websiteOnly, calls } = fakeProvider({ audiences: ['website.public'] });
  const wrongAudience = await createOutboxRunner({ core, provider: websiteOnly, actor: RUNNER }).processOnce();
  assert.equal(wrongAudience.results[0].action, 'refused');
  assert.equal(wrongAudience.results[0].reason, 'audience_not_allowed');
  assert.equal(wrongAudience.results[0].audience, 'chat.event_space');
  assert.equal(calls.deliver, 0);
  assert.equal(intentOf(core, job.id).state, 'pending');
});

test('an article is refused while the lead has not confirmed facts and consent is missing', async () => {
  const core = harness();
  const activityId = completedActivity(core);
  const publication = core.createPublicationDraft({
    actor: ADMIN, activityId, title: 'Workshop recap', body: 'What happened.', channels: ['website'],
  });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: publication.id });
  const stray = core.enqueueExternalIntent({
    actor: ADMIN, activityId, kind: 'publish_article',
    payload: { publicationId: publication.id, channels: ['website'] },
  });
  const { provider, calls } = fakeProvider();
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  // The core itself refuses to publish before the lead confirms facts.
  assert.throws(() => core.publishPublication({ actor: ADMIN, publicationId: publication.id }),
    error => error.code === 'invalid_transition');

  const refused = await runner.processOnce();
  assert.equal(refused.results[0].action, 'refused');
  assert.equal(refused.results[0].reason, 'intent_not_registered_for_publication');
  assert.equal(calls.deliver, 0);
  assert.equal(intentOf(core, stray.job.id).state, 'pending');
  assert.equal(core.getPublication(publication.id).state, 'awaiting_confirmation');
});

test('a confirmed, consented article is delivered once and its link is stored', async () => {
  const core = harness();
  const activityId = completedActivity(core);
  const publication = core.createPublicationDraft({
    actor: ADMIN, activityId, title: 'Workshop recap', body: 'What happened.', channels: ['website'],
  });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: publication.id });

  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: publication.id }).confirmed, false);
  core.recordConsent({ actor: ADMIN, activityId, channel: 'website', granted: true });
  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: publication.id }).confirmed, true);
  const published = core.publishPublication({ actor: ADMIN, publicationId: publication.id });
  let deliveredEnvelope;
  const { provider, calls } = fakeProvider({ deliver(envelope) {
    deliveredEnvelope = envelope;
    return { receipt: { providerRef: 'site-1', url: 'https://example.org/events/1' } };
  } });
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(calls.deliver, 1);
  assert.deepEqual(deliveredEnvelope.publication, {
    id: publication.id, title: 'Workshop recap', body: 'What happened.', channels: ['website'], materialIds: [],
  });
  assert.deepEqual(report.delivered.map(entry => entry.jobId), [published.job.id]);
  const stored = core.getPublication(publication.id);
  assert.equal(stored.state, 'published');
  assert.equal(stored.url, 'https://example.org/events/1');
  assert.equal(intentOf(core, published.job.id).receipt.url, 'https://example.org/events/1');

  await runner.processOnce();
  assert.equal(calls.deliver, 1);
});

test('a delivery with no provider receipt is never reported as delivered', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });

  const { provider: silent, calls: silentCalls } = fakeProvider({
    consistency: 'eventual',
    deliver: () => ({ processed: true }),
    lookup: () => null,
  });
  const held = await createOutboxRunner({ core, provider: silent, actor: RUNNER }).processOnce();
  assert.equal(held.results[0].action, 'held');
  assert.equal(silentCalls.deliver, 1);
  assert.deepEqual(held.delivered, []);
  assert.equal(intentOf(core, job.id).state, 'uncertain');
  assert.equal(core.getActivity(activityId).space.state, 'pending');

  const { provider: recoverable, calls: recoverableCalls } = fakeProvider({
    deliver: () => ({ processed: true }),
    lookup: () => ({ found: true, receipt: { providerRef: 'late-1', url: 'https://example.org/events/late' } }),
  });
  const recovered = await createOutboxRunner({ core, provider: recoverable, actor: RUNNER }).processOnce();
  assert.equal(recovered.results[0].action, 'reconciled_delivered');
  assert.equal(recoverableCalls.deliver, 0);
  assert.equal(recoverableCalls.lookup, 1);
  assert.equal(core.getActivity(activityId).space.state, 'created');
});

test('a receipt without a resource reference or with a mismatched key stays uncertain', async () => {
  for (const receipt of [{}, { providerRef: 'space-1', key: 'some-other-operation' }]) {
    const core = harness();
    const activityId = approvedActivity(core);
    const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
    const { provider } = fakeProvider({ consistency: 'eventual', deliver: () => ({ receipt }), lookup: () => null });
    const report = await createOutboxRunner({ core, provider, actor: RUNNER }).processOnce();
    assert.deepEqual(report.delivered, []);
    assert.equal(intentOf(core, job.id).state, 'uncertain');
    assert.equal(core.getActivity(activityId).space.state, 'pending');
  }
});

test('an intent left uncertain by a crashed process is looked up, not re-delivered', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const crashed = reseed(core, [{
    id: 'job-77', key: 'create_space:activity-1', kind: 'create_space', activityId,
    payload: { activityId }, state: 'uncertain', note: 'process died mid-delivery',
  }]);
  const { provider, calls } = fakeProvider({
    lookup: () => ({ found: true, receipt: { providerRef: 'crash-space', url: 'https://example.org/events/crash' } }),
  });
  const report = await createOutboxRunner({ core: crashed, provider, actor: RUNNER }).processOnce();
  assert.equal(report.results[0].action, 'reconciled_delivered');
  assert.equal(calls.deliver, 0);
  assert.equal(calls.lookup, 1);
  assert.equal(intentOf(crashed, 'job-77').state, 'delivered');
  assert.equal(crashed.getActivity(activityId).space.url, 'https://example.org/events/crash');
});

test('private-looking payload fields and unreachable private audiences block delivery', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const privateNote = core.enqueueExternalIntent({
    actor: ADMIN, activityId, kind: 'post_standing_summary',
    payload: { audience: 'chat.event_space', contactList: ['lead@example.org'] },
  });
  const { provider, calls } = fakeProvider();
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const sensitive = await runner.processOnce({ jobs: [privateNote.job.id] });
  assert.equal(sensitive.results[0].action, 'refused');
  assert.equal(sensitive.results[0].reason, 'payload_contains_sensitive_field');
  assert.deepEqual(sensitive.results[0].fields, ['$.contactList']);
  assert.equal(calls.deliver, 0);

  const boardOnly = core.enqueueExternalIntent({
    actor: ADMIN, activityId, kind: 'post_standing_summary',
    payload: { audience: 'board.private', summary: 'board agenda' },
  });
  const restricted = await runner.processOnce({ jobs: [boardOnly.job.id] });
  assert.equal(restricted.results[0].action, 'refused');
  assert.equal(restricted.results[0].reason, 'audience_restricted');
  assert.equal(calls.deliver, 0);
  assert.equal(intentOf(core, boardOnly.job.id).state, 'pending');
});

test('a definitive provider rejection is persisted as failed and waits for a handler', async () => {
  const core = harness();
  const activityId = approvedActivity(core);
  const { job } = core.requestActivitySpace({ actor: ADMIN, activityId });
  const { provider, calls } = fakeProvider({
    deliver: () => { throw new ProviderRejectionError('channel creation is not permitted for this token'); },
  });
  const runner = createOutboxRunner({ core, provider, actor: RUNNER });

  const report = await runner.processOnce();
  assert.equal(report.results[0].action, 'failed');
  assert.equal(report.results[0].reason, 'provider_rejected');
  assert.equal(calls.deliver, 1);
  assert.equal(calls.lookup, 0);
  const intent = intentOf(core, job.id);
  assert.equal(intent.state, 'failed');
  assert.match(intent.note, /not permitted/);

  const second = await runner.processOnce();
  assert.equal(second.results[0].action, 'skipped');
  assert.equal(second.results[0].reason, 'awaiting_retry');
  assert.equal(calls.deliver, 1);
});

test('a published article link reaches the event space only through an allowed chat audience', async () => {
  const core = harness();
  const { publicationId, linkJob } = publishedArticle(core);
  assert.ok(linkJob, 'the core queued a link-return intent for the created event space');
  assert.equal(linkJob.kind, 'post_article_link');
  assert.equal(DELIVERABLE_INTENT_KINDS.includes('post_article_link'), true);
  assert.equal(core.getPublication(publicationId).linkReturned, false, 'no receipt means no returned link');
  assert.equal(core.getPublication(publicationId).linkDeliveryState, 'pending');

  // A website-only provider must not post the link into the chat space, and the refusal must not
  // move the publication or the intent.
  const { provider: websiteOnly, calls: websiteCalls } = fakeProvider({
    id: 'fake-website', audiences: ['website.public'],
  });
  const wrongAudience = await createOutboxRunner({ core, provider: websiteOnly, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });
  assert.equal(wrongAudience.results[0].action, 'refused');
  assert.equal(wrongAudience.results[0].reason, 'audience_not_allowed');
  assert.equal(wrongAudience.results[0].audience, 'chat.event_space');
  assert.equal(websiteCalls.deliver, 0);
  assert.equal(intentOf(core, linkJob.id).state, 'pending');
  assert.equal(core.getPublication(publicationId).linkReturned, false);

  let deliveredEnvelope;
  const { provider: chat, calls: chatCalls } = fakeProvider({
    id: 'fake-chat',
    audiences: ['chat.event_space'],
    deliver(envelope) {
      deliveredEnvelope = envelope;
      return { receipt: { providerRef: 'message-9' } };
    },
  });
  const report = await createOutboxRunner({ core, provider: chat, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });
  assert.equal(chatCalls.deliver, 1);
  assert.equal(report.results[0].action, 'delivered');
  assert.deepEqual(report.delivered.map(entry => entry.jobId), [linkJob.id]);
  assert.deepEqual(deliveredEnvelope.audiences, ['chat.event_space']);
  assert.equal(deliveredEnvelope.audience, 'chat.event_space');
  assert.equal(deliveredEnvelope.kind, 'post_article_link');
  assert.deepEqual(deliveredEnvelope.payload, {
    audience: 'chat.event_space', publicationId, url: 'https://example.org/articles/9',
  });
  assert.deepEqual(deliveredEnvelope.link, {
    publicationId, title: 'Workshop recap', url: 'https://example.org/articles/9',
  });
  assert.equal(deliveredEnvelope.publication, null, 'the article body is not copied into the chat envelope');

  const stored = core.getPublication(publicationId);
  assert.equal(stored.linkReturned, true, 'the provider receipt is what makes the link returned');
  assert.equal(stored.linkDeliveryState, 'delivered');
  assert.equal(intentOf(core, linkJob.id).state, 'delivered');
  assert.equal(intentOf(core, linkJob.id).receipt.providerRef, 'message-9');
  assert.equal(intentOf(core, linkJob.id).receipt.provider, 'fake-chat');

  const second = await createOutboxRunner({ core, provider: chat, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });
  assert.equal(chatCalls.deliver, 1);
  assert.equal(second.results[0].action, 'already_delivered');
});

test('a link intent that does not carry the published canonical URL is refused', async () => {
  const core = harness();
  const { publicationId, linkJob } = publishedArticle(core);
  const tampered = reseed(core, [{
    id: linkJob.id, key: linkJob.key, kind: linkJob.kind, activityId: linkJob.activityId,
    state: 'pending',
    payload: { audience: 'chat.event_space', publicationId, url: 'https://phishing.example/recap' },
  }]);
  const { provider, calls } = fakeProvider({ id: 'fake-chat', audiences: ['chat.event_space'] });
  const report = await createOutboxRunner({ core: tampered, provider, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });

  assert.equal(report.results[0].action, 'refused');
  assert.equal(report.results[0].reason, 'publication_link_mismatch');
  assert.equal(calls.deliver, 0);
  assert.equal(tampered.getPublication(publicationId).linkReturned, false);
  assert.equal(intentOf(tampered, linkJob.id).state, 'pending');
});

test('a link intent without a payload audience still resolves to the chat event space', async () => {
  const core = harness();
  const { publicationId, linkJob } = publishedArticle(core);
  // A legacy or restored intent may predate the payload audience; the kind mapping must still
  // decide the audience instead of leaving the intent unaddressed or reaching the public website.
  const legacy = reseed(core, [{
    id: linkJob.id, key: linkJob.key, kind: linkJob.kind, activityId: linkJob.activityId,
    state: 'pending',
    payload: { publicationId, url: 'https://example.org/articles/9' },
  }]);

  const { provider: websiteOnly, calls: websiteCalls } = fakeProvider({
    id: 'fake-website', audiences: ['website.public'],
  });
  const refused = await createOutboxRunner({ core: legacy, provider: websiteOnly, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });
  assert.equal(refused.results[0].action, 'refused');
  assert.equal(refused.results[0].reason, 'audience_not_allowed');
  assert.equal(refused.results[0].audience, 'chat.event_space');
  assert.equal(websiteCalls.deliver, 0);

  let deliveredEnvelope;
  const { provider: chat, calls: chatCalls } = fakeProvider({
    id: 'fake-chat',
    audiences: ['chat.event_space'],
    deliver(envelope) { deliveredEnvelope = envelope; return { receipt: { providerRef: 'message-legacy' } }; },
  });
  const report = await createOutboxRunner({ core: legacy, provider: chat, actor: RUNNER })
    .processOnce({ jobs: [linkJob.id] });
  assert.equal(chatCalls.deliver, 1);
  assert.equal(report.results[0].action, 'delivered');
  assert.deepEqual(deliveredEnvelope.audiences, ['chat.event_space']);
  assert.equal(legacy.getPublication(publicationId).linkReturned, true);
});
