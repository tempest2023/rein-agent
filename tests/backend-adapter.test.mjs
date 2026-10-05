import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackendReader,
  createBackendWriter,
  stripActorFields,
} from '../plugins/rein-operations/backend-db-adapter.ts';

const PROOF = Object.freeze({ kind: 'assertion', assertion: 'opaque' });

/**
 * The operations route answers `{ ok, operation, result }`; the adapter must read the result and
 * refuse anything that is not that envelope.
 */
const envelopeOf = (result, { operation = 'op', ok = true } = {}) => ({ ok: true, operation, result, ...(ok ? {} : {}) });

function stubTransport(results, identity) {
  const calls = [];
  return {
    calls,
    baseUrl: 'https://rein.example.org',
    async operations(operation, input, sentProof) {
      calls.push({ operation, input, proof: sentProof });
      const next = results[operation];
      if (!next) return { ok: false, reason: 'http_error', httpStatus: 500 };
      return next;
    },
    async resolveIdentity(sentProof) {
      calls.push({ operation: 'identity.resolve', input: null, proof: sentProof });
      if (!identity) return { ok: false, reason: 'http_error', httpStatus: 500 };
      return identity;
    },
    async relayIngress() {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    },
    async linkStart() {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    },
    async linkComplete() {
      return { ok: false, reason: 'invalid_request', httpStatus: null };
    },
  };
}

const readerFor = (
  results,
  workspace = { platform: 'slack', workspaceId: 'T0TEAM', nativeChannelId: 'C0BOARD' },
  identity,
) => {
  const transport = stubTransport(results, identity);
  return {
    transport,
    reader: createBackendReader({ transport, getProof: () => ({ ok: true, proof: PROOF }), ...workspace }),
  };
};

const writerFor = (results, identity = { platform: 'slack', workspaceId: 'T0TEAM', nativeChannelId: 'C0BOARD' }) => {
  const transport = stubTransport(results);
  return {
    transport,
    writer: createBackendWriter({ transport, getProof: () => ({ ok: true, proof: PROOF }), ...identity }),
  };
};

test('the reader maps member status and funds, and always refuses to authorize spending', async () => {
  const { transport, reader } = readerFor(
    {
      available_funds: {
        ok: true,
        httpStatus: 200,
        body: envelopeOf(
          {
            status: 'snapshot',
            reason: 'snapshot',
            currency: 'USD',
            availableMinor: 1000,
            recordedAt: 'x',
            recordedBy: 'y',
            sourceNote: null,
          },
          { operation: 'available_funds' },
        ),
      },
    },
    { platform: 'slack', workspaceId: 'T0TEAM', nativeChannelId: 'C0BOARD' },
    {
      ok: true,
      httpStatus: 200,
      body: {
        ok: true,
        status: 'resolved',
        contact_id: 'c1',
        is_active_contributor: true,
        is_director: false,
      },
    },
  );
  const member = await reader.resolveSlackMember('U1');
  assert.equal(member.status, 'resolved');
  assert.equal(member.matchedBy, 'platform_link');
  assert.equal(member.contactId, 'c1');
  assert.equal(member.isActiveContributor, true);
  const funds = await reader.readAvailableFunds('usd');
  assert.equal(funds.status, 'snapshot');
  assert.equal(funds.availableMinor, 1000);
  assert.equal(funds.authorizesSpending, false);
  assert.equal(transport.calls[0].operation, 'identity.resolve');
  assert.deepEqual(transport.calls[0].proof, PROOF);
  assert.deepEqual(transport.calls[1].input, {
    platform: 'slack',
    workspaceId: 'T0TEAM',
    channelId: 'C0BOARD',
    currency: 'USD',
  });
});

test('identity discovery reports unlinked and revoked from the resolve envelope, never as roles', async () => {
  const unlinked = readerFor({}, undefined, {
    ok: true,
    httpStatus: 200,
    body: { ok: true, status: 'identity_not_linked', contact_id: null, is_active_contributor: false, is_director: false },
  });
  const unlinkedMember = await unlinked.reader.resolveSlackMember('U1');
  assert.equal(unlinkedMember.status, 'identity_not_linked');
  assert.equal(unlinkedMember.contactId, null);
  assert.equal(unlinkedMember.matchedBy, null);
  assert.equal(unlinkedMember.isActiveContributor, false);
  assert.equal(unlinkedMember.isDirector, false);

  const revoked = readerFor({}, undefined, {
    ok: true,
    httpStatus: 200,
    body: { ok: true, status: 'identity_revoked', contact_id: 'c1', is_active_contributor: true, is_director: true },
  });
  const revokedMember = await revoked.reader.resolveSlackMember('U1');
  assert.equal(revokedMember.status, 'identity_revoked');
  assert.equal(revokedMember.contactId, null, 'a revoked identity never hands back a contact');
  assert.equal(revokedMember.matchedBy, null);
  assert.equal(revokedMember.isActiveContributor, false);
  assert.equal(revokedMember.isDirector, false);

  const garbage = readerFor({}, undefined, { ok: true, httpStatus: 200, body: { ok: true, status: 'weird' } });
  const garbageMember = await garbage.reader.resolveSlackMember('U1');
  assert.equal(garbageMember.status, 'unavailable');
  assert.equal(garbageMember.contactId, null);
});

test('the operations envelope is required: a flattened or partial body is malformed, never read as a success', async () => {
  const flat = readerFor({
    available_funds: {
      ok: true,
      httpStatus: 200,
      body: { status: 'snapshot', reason: 'snapshot', currency: 'USD', availableMinor: 1000 },
    },
  });
  const funds = await flat.reader.readAvailableFunds('USD');
  assert.equal(funds.status, 'unavailable');
  assert.equal(funds.reason, 'response_malformed');
  assert.equal(funds.availableMinor, null);

  const missingResult = writerFor({
    get_proposal: { ok: true, httpStatus: 200, body: { ok: true, operation: 'get_proposal' } },
  });
  const read = await missingResult.writer.getProposal('p1');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'response_malformed');
  assert.equal(read.proposal, null);

  const mismatched = writerFor({
    submit_proposal: {
      ok: true,
      httpStatus: 200,
      body: { ok: true, operation: 'create_poll', result: { ok: true, status: 'inserted', reason: 'inserted', proposal: { id: 'p1' } } },
    },
  });
  const written = await mismatched.writer.submitProposal({ id: 'p1', proposerContactId: 'x', title: 't', voteType: 'v' });
  assert.equal(written.ok, true);
  assert.deepEqual(written.proposal, { id: 'p1' });
});

test('an unusable sender id is refused before any backend call', async () => {
  const { transport, reader } = readerFor({});
  const result = await reader.resolveSlackMember('   ');
  assert.equal(result.status, 'invalid_request');
  assert.equal(transport.calls.length, 0);
});

test('a transport failure closes the reader instead of reading as unlinked', async () => {
  const { reader } = readerFor({});
  const member = await reader.resolveSlackMember('U1');
  assert.equal(member.status, 'unavailable');
  assert.equal(member.contactId, null);
  const funds = await reader.readAvailableFunds('USD');
  assert.equal(funds.status, 'unavailable');
  assert.equal(funds.availableMinor, null);
});

test('a missing proof fails one call closed instead of throwing, and the next call can still succeed', async () => {
  const transport = stubTransport({
    get_proposal: {
      ok: true,
      httpStatus: 200,
      body: envelopeOf({ ok: true, status: 'found', reason: 'found', proposal: { id: 'p1' } }),
    },
  });
  let proof = { ok: false, reason: 'proof_unavailable' };
  const writer = createBackendWriter({
    transport,
    getProof: () => proof,
    platform: 'slack',
    workspaceId: 'T0TEAM',
    nativeChannelId: 'C0BOARD',
  });
  const closed = await writer.getProposal('p1');
  assert.equal(closed.ok, false);
  assert.equal(closed.status, 'unavailable');
  assert.equal(closed.reason, 'transport_error');
  assert.equal(transport.calls.length, 0);

  proof = { ok: true, proof: { kind: 'assertion', assertion: 'opaque' } };
  const found = await writer.getProposal('p1');
  assert.equal(found.ok, true);
  assert.deepEqual(found.proposal, { id: 'p1' });
  assert.equal(transport.calls.length, 1);
});

test('every actor-like field is stripped before the wire, including authorContactId', async () => {
  const { transport, writer } = writerFor({
    submit_proposal: {
      ok: true,
      httpStatus: 200,
      body: envelopeOf({ ok: true, status: 'inserted', reason: 'inserted', proposal: { id: 'p1' } }),
    },
    finalize_poll: {
      ok: true,
      httpStatus: 200,
      body: envelopeOf(
        { ok: true, status: 'updated', reason: 'updated', finalization: { pollId: 'poll1' } },
        { operation: 'finalize_poll' },
      ),
    },
    record_proposal_revision: {
      ok: true,
      httpStatus: 200,
      body: envelopeOf({ ok: true, status: 'inserted', reason: 'inserted', revision: { id: 'r1' } }),
    },
  });
  await writer.submitProposal({ id: 'p1', proposerContactId: 'SHOULD-NOT-TRAVEL', title: 't', voteType: 'v' });
  assert.equal(transport.calls[0].operation, 'submit_proposal');
  assert.ok(!Object.hasOwn(transport.calls[0].input, 'proposerContactId'));
  assert.equal(transport.calls[0].input.title, 't');
  await writer.finalizePoll({ pollId: 'poll1', actorContactId: 'SHOULD-NOT-TRAVEL' });
  assert.ok(!Object.hasOwn(transport.calls[1].input, 'actorContactId'));
  await writer.recordProposalRevision({
    id: 'r1',
    proposalId: 'p1',
    authorContactId: 'SHOULD-NOT-TRAVEL',
    changedFields: ['title'],
    title: 'New title',
  });
  assert.ok(!Object.hasOwn(transport.calls[2].input, 'authorContactId'));
  assert.equal(transport.calls[2].input.title, 'New title');
  assert.deepEqual(stripActorFields({ a: 1, voterContactId: 'x', authorContactId: 'y', callerId: 'z', proof: {} }), { a: 1 });
});

test('the writer preserves the result envelope and closes on failure', async () => {
  const { writer } = writerFor({
    get_proposal: {
      ok: true,
      httpStatus: 200,
      body: envelopeOf({ ok: true, status: 'found', reason: 'found', proposal: { id: 'p1' } }),
    },
    get_revision: { ok: false, reason: 'auth_error', httpStatus: 401 },
  });
  const found = await writer.getProposal('p1');
  assert.equal(found.ok, true);
  assert.equal(found.status, 'found');
  assert.deepEqual(found.proposal, { id: 'p1' });
  const denied = await writer.getRevision('r1');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'unavailable');
  assert.equal(denied.reason, 'auth_error');
  assert.equal(denied.httpStatus, 401);
});

test('the adapter requires a transport and a resolved workspace, and every call carries them', () => {
  const transport = stubTransport({});
  assert.throws(
    () => createBackendReader({ transport, getProof: () => ({ ok: true, proof: PROOF }), platform: '', workspaceId: 'T', nativeChannelId: 'C' }),
    /resolved platform, workspace and channel/,
  );
  assert.doesNotThrow(() =>
    createBackendWriter({ transport, getProof: () => ({ ok: true, proof: PROOF }), platform: 'discord', workspaceId: 'G1', nativeChannelId: 'C9' }),
  );
});

test('the resolved platform and workspace travel with every operation call, and identity rides the proof', async () => {
  const { transport, reader } = readerFor(
    {
      available_funds: {
        ok: true,
        httpStatus: 200,
        body: envelopeOf({ status: 'unknown', reason: 'unknown', currency: 'USD', availableMinor: null }),
      },
    },
    { platform: 'discord', workspaceId: 'G0GUILD', nativeChannelId: 'C0BOARD' },
    {
      ok: true,
      httpStatus: 200,
      body: { ok: true, status: 'identity_not_linked', contact_id: null, is_active_contributor: false, is_director: false },
    },
  );
  await reader.resolveSlackMember('U1');
  assert.equal(transport.calls[0].operation, 'identity.resolve');
  assert.deepEqual(transport.calls[0].proof, PROOF);
  await reader.readAvailableFunds('USD');
  assert.equal(transport.calls[1].input.platform, 'discord');
  assert.equal(transport.calls[1].input.workspaceId, 'G0GUILD');
  assert.equal(transport.calls[1].input.channelId, 'C0BOARD');
  assert.equal(JSON.stringify(transport.calls[1]).includes('identity_not_linked'), false);
});
