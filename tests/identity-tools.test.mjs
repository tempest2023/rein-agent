import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_BIND_CLOSED_REASON,
  IDENTITY_BIND_TOOL_NAMES,
  createIdentityToolsRegistration,
} from '../plugins/rein-operations/identity-tools.ts';
import { createBackendProof } from '../plugins/rein-operations/backend-transport.ts';

const proof = () => {
  const value = createBackendProof('opaque-assertion-value');
  assert.ok(value);
  return value;
};

function runtimeStub(responses) {
  const calls = [];
  let index = 0;
  const next = () => responses[Math.min(index, responses.length - 1)];
  return {
    calls,
    transport: {
      async linkStart(requestProof) {
        calls.push({ path: 'start', proof: requestProof });
        index += 1;
        return next();
      },
      async linkStatus(sessionId, requestProof) {
        calls.push({ path: 'status', sessionId, proof: requestProof });
        index += 1;
        return next();
      },
      async linkComplete(bindingCode, requestProof) {
        calls.push({ path: 'complete', bindingCode, proof: requestProof });
        index += 1;
        return next();
      },
    },
  };
}

const registrationWith = (stub, resolution) =>
  createIdentityToolsRegistration({
    runtime: { ...stub, proofProvider: () => resolution },
  });

const readDetails = (result) => JSON.parse(result.content[0].text);

test('the bind tools carry their three names and nothing else', () => {
  assert.deepEqual([...IDENTITY_BIND_TOOL_NAMES], [
    'rein_identity_bind_start',
    'rein_identity_bind_status',
    'rein_identity_bind_complete',
  ]);
});

test('binding start accepts no argument and returns the website URL and expiry', async () => {
  const stub = runtimeStub([
    {
      ok: true,
      httpStatus: 200,
      body: {
        ok: true,
        status: 'started',
        session_id: 'link_session_1',
        verification_url: 'https://rein-protocol.org/link/link_session_1',
        expires_at: '2026-09-30T17:15:00Z',
      },
    },
  ]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const tools = registration.create({});
  const start = tools.find(tool => tool.name === 'rein_identity_bind_start');

  const schemaKeys = Object.keys(start.parameters.properties ?? {});
  assert.deepEqual(schemaKeys, []);

  const details = readDetails(await start.execute('call_1', {}));
  assert.equal(details.ok, true);
  assert.equal(details.sessionId, 'link_session_1');
  assert.equal(details.verificationUrl, 'https://rein-protocol.org/link/link_session_1');
  assert.equal(details.expiresAt, '2026-09-30T17:15:00Z');
  assert.equal(details.recorded, false);
  assert.equal(stub.calls[0].path, 'start');
});

test('binding start carries the proof to the transport and never into the result', async () => {
  const stub = runtimeStub([
    { ok: true, httpStatus: 200, body: { ok: true, status: 'started', session_id: 'link_session_1', verification_url: 'https://rein-protocol.org/link/link_session_1', expires_at: '2026-09-30T17:15:00Z' } },
  ]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const start = registration.create({}).find(tool => tool.name === 'rein_identity_bind_start');
  const result = await start.execute('call_1', {});
  assert.deepEqual(stub.calls[0].proof, { kind: 'assertion', assertion: 'opaque-assertion-value' });
  assert.ok(!JSON.stringify(result).includes('opaque-assertion-value'));
});

test('a model-supplied email or claimed identity is not part of the bind surface', async () => {
  const stub = runtimeStub([
    { ok: true, httpStatus: 200, body: { ok: true, status: 'started', session_id: 'link_session_1', verification_url: 'https://rein-protocol.org/link/link_session_1', expires_at: '2026-09-30T17:15:00Z' } },
  ]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const start = registration.create({}).find(tool => tool.name === 'rein_identity_bind_start');
  await start.execute('call_1', { email: 'attacker@example.org', contactId: 'contact-1', userId: 'U0ATTACKER' });
  assert.deepEqual(Object.keys(stub.calls[0]), ['path', 'proof']);
});

test('binding complete takes the code as its only argument', async () => {
  const stub = runtimeStub([{ ok: true, httpStatus: 200, body: { ok: true, status: 'completed', link_id: 'link_1', contact_id: 'contact_1' } }]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const complete = registration.create({}).find(tool => tool.name === 'rein_identity_bind_complete');
  assert.deepEqual(Object.keys(complete.parameters.properties), ['bindingCode']);
  assert.equal(complete.parameters.additionalProperties, false);

  const details = readDetails(await complete.execute('call_1', { bindingCode: '  ABC-123  ' }));
  assert.equal(details.ok, true);
  assert.equal(details.linkId, 'link_1');
  assert.equal(stub.calls[0].bindingCode, 'ABC-123');
  assert.equal(stub.calls[0].path, 'complete');
});

test('binding status reports an unregistered verified address with the administrator next step', async () => {
  const stub = runtimeStub([{
    ok: true,
    httpStatus: 200,
    body: {
      ok: true,
      state: 'registration_required',
      linked: false,
      contact_id: null,
      expires_at: '2026-09-30T17:15:00Z',
    },
  }]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const status = registration.create({}).find(tool => tool.name === 'rein_identity_bind_status');
  assert.deepEqual(Object.keys(status.parameters.properties), ['sessionId']);

  const details = readDetails(await status.execute('call_1', { sessionId: ' link_session_1 ' }));
  assert.equal(details.ok, true);
  assert.equal(details.status, 'registration_required');
  assert.equal(details.linked, false);
  assert.equal(details.registrationRequired, true);
  assert.equal(details.nextStep, 'contact_administrator_to_register');
  assert.match(details.message, /administrator/);
  assert.equal(details.recorded, false);
  assert.equal(stub.calls[0].sessionId, 'link_session_1');
  assert.ok(!JSON.stringify(details).includes('contact_id'));
});

test('binding status refuses bad session ids and malformed backend states', async () => {
  const invalidStub = runtimeStub([{ ok: true, httpStatus: 200, body: {} }]);
  const invalid = registrationWith(invalidStub, { ok: true, proof: proof() })
    .create({})
    .find(tool => tool.name === 'rein_identity_bind_status');
  for (const args of [undefined, {}, { sessionId: '' }, { sessionId: 'x'.repeat(300) }]) {
    const details = readDetails(await invalid.execute('call_1', args));
    assert.equal(details.reason, 'binding_session_invalid');
  }
  assert.equal(invalidStub.calls.length, 0);

  for (const body of [
    {},
    { ok: true, state: 'registration_required' },
    { ok: true, state: 'unknown', linked: false },
    { ok: true, state: 'completed', linked: false },
  ]) {
    const stub = runtimeStub([{ ok: true, httpStatus: 200, body }]);
    const status = registrationWith(stub, { ok: true, proof: proof() })
      .create({})
      .find(tool => tool.name === 'rein_identity_bind_status');
    const details = readDetails(await status.execute('call_1', { sessionId: 'link_session_1' }));
    assert.equal(details.reason, 'binding_status_malformed');
    assert.equal(details.recorded, false);
  }
});

test('a 200 that denies the bind is reported as unavailable rather than success', async () => {
  for (const body of [{ ok: false }, { ok: false, status: 'refused', reason: 'code_expired' }]) {
    const startStub = runtimeStub([{ ok: true, httpStatus: 200, body }]);
    const start = registrationWith(startStub, { ok: true, proof: proof() })
      .create({})
      .find(tool => tool.name === 'rein_identity_bind_start');
    const startDetails = readDetails(await start.execute('call_1', {}));
    assert.equal(startDetails.ok, false);
    assert.equal(startDetails.status, 'unavailable');
    assert.equal(startDetails.recorded, false);
    assert.equal(startDetails.verificationUrl, undefined);

    const completeStub = runtimeStub([{ ok: true, httpStatus: 200, body }]);
    const complete = registrationWith(completeStub, { ok: true, proof: proof() })
      .create({})
      .find(tool => tool.name === 'rein_identity_bind_complete');
    const completeDetails = readDetails(await complete.execute('call_1', { bindingCode: 'ABC-123' }));
    assert.equal(completeDetails.ok, false);
    assert.equal(completeDetails.status, 'unavailable');
    assert.equal(completeDetails.recorded, false);
  }
});

test('a 200 that omits the bind tuple is reported as unavailable rather than success', async () => {
  const startBodies = [
    undefined,
    {},
    { ok: true },
    { ok: true, session_id: 'link_session_1' },
    { ok: true, session_id: 'link_session_1', verification_url: '' },
    { ok: true, session_id: 'link_session_1', verification_url: 'not-a-url' },
    { ok: true, session_id: '   ', verification_url: 'https://rein-protocol.org/link/1' },
  ];
  for (const body of startBodies) {
    const stub = runtimeStub([{ ok: true, httpStatus: 200, body }]);
    const start = registrationWith(stub, { ok: true, proof: proof() })
      .create({})
      .find(tool => tool.name === 'rein_identity_bind_start');
    const details = readDetails(await start.execute('call_1', {}));
    assert.equal(details.ok, false, JSON.stringify(body));
    assert.equal(details.status, 'unavailable');
    assert.equal(details.reason, 'binding_start_malformed');
    assert.equal(details.recorded, false);
  }

  const completeBodies = [
    undefined,
    {},
    { ok: true },
    { ok: true, contact_id: 'contact_1' },
    { ok: true, link_id: 'link_1' },
    { ok: true, link_id: '', contact_id: 'contact_1' },
    { ok: true, link_id: 'link_1', contact_id: '   ' },
  ];
  for (const body of completeBodies) {
    const stub = runtimeStub([{ ok: true, httpStatus: 200, body }]);
    const complete = registrationWith(stub, { ok: true, proof: proof() })
      .create({})
      .find(tool => tool.name === 'rein_identity_bind_complete');
    const details = readDetails(await complete.execute('call_1', { bindingCode: 'ABC-123' }));
    assert.equal(details.ok, false, JSON.stringify(body));
    assert.equal(details.status, 'unavailable');
    assert.equal(details.reason, 'binding_completion_malformed');
    assert.equal(details.recorded, false);
  }
});

test('binding complete refuses an empty, missing or oversized code without calling the backend', async () => {
  const stub = runtimeStub([{ ok: true, httpStatus: 200, body: {} }]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const complete = registration.create({}).find(tool => tool.name === 'rein_identity_bind_complete');
  for (const args of [undefined, {}, { bindingCode: '' }, { bindingCode: '   ' }, { bindingCode: 'x'.repeat(600) }]) {
    const details = readDetails(await complete.execute('call_1', args));
    assert.equal(details.ok, false);
    assert.equal(details.reason, 'binding_code_invalid');
  }
  assert.equal(stub.calls.length, 0);
});

test('all binding tools fail closed when the host context carries no proof', async () => {
  const stub = runtimeStub([{ ok: true, httpStatus: 200, body: {} }]);
  for (const resolution of [{ ok: false, reason: 'proof_unavailable' }, null, undefined]) {
    const registration = registrationWith(stub, resolution);
    const tools = registration.create({});
    const start = readDetails(
      await tools.find(tool => tool.name === 'rein_identity_bind_start').execute('call_1', {}),
    );
    const complete = readDetails(
      await tools
        .find(tool => tool.name === 'rein_identity_bind_complete')
        .execute('call_1', { bindingCode: 'ABC' }),
    );
    const status = readDetails(
      await tools
        .find(tool => tool.name === 'rein_identity_bind_status')
        .execute('call_1', { sessionId: 'link_session_1' }),
    );
    assert.equal(start.ok, false);
    assert.equal(start.reason, IDENTITY_BIND_CLOSED_REASON);
    assert.equal(complete.ok, false);
    assert.equal(complete.reason, IDENTITY_BIND_CLOSED_REASON);
    assert.equal(status.ok, false);
    assert.equal(status.reason, IDENTITY_BIND_CLOSED_REASON);
  }
  assert.equal(stub.calls.length, 0);
});

test('a backend refusal is reported as unavailable and never as a recorded binding', async () => {
  const stub = runtimeStub([{ ok: false, reason: 'auth_error', httpStatus: 401 }]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const complete = registration.create({}).find(tool => tool.name === 'rein_identity_bind_complete');
  const details = readDetails(await complete.execute('call_1', { bindingCode: 'ABC-123' }));
  assert.equal(details.ok, false);
  assert.equal(details.status, 'unavailable');
  assert.equal(details.recorded, false);
  assert.equal(details.httpStatus, 401);
});

test('a completed binding states that nothing was authorized to spend and posts nothing', async () => {
  const stub = runtimeStub([{ ok: true, httpStatus: 200, body: { ok: true, status: 'completed', link_id: 'link_1', contact_id: 'contact_1' } }]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  const complete = registration.create({}).find(tool => tool.name === 'rein_identity_bind_complete');
  const details = readDetails(await complete.execute('call_1', { bindingCode: 'ABC-123' }));
  assert.equal(details.recorded, true);
  assert.equal(details.authorizesSpending, false);
});

test('the registration keeps contextVersion 2 so the runtime wrapper can hold the invocation guard', () => {
  const stub = runtimeStub([]);
  const registration = registrationWith(stub, { ok: true, proof: proof() });
  assert.equal(registration.contextVersion, 2);
});
