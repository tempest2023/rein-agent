import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, LedgerError } from '../plugins/rein-operations/ledger.ts';

test('ledger persists one atomic revision, audit and idempotent receipt across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-ledger-'));
  try {
    const file = join(dir, 'state.json');
    const args = { key: 'message-1', actor: 'synthetic-member', action: 'draft', at: '2026-09-23T00:00:00Z' };
    const first = createLedger(file).transact({ ...args, apply(records) { records.count = (records.count ?? 0) + 1; return records.count; } });
    const second = createLedger(file).transact({ ...args, apply() { throw Error('must not replay'); } });
    assert.deepEqual(second, first);
    assert.throws(() => createLedger(file).transact({ ...args, actor: 'another-member', apply() {} }),
      error => error instanceof LedgerError && error.code === 'idempotency_conflict');
    assert.deepEqual(createLedger(file).snapshot(), {
      revision: 1, records: { count: 1 }, receipts: { 'message-1': first },
      audit: [{ key: 'message-1', actor: 'synthetic-member', action: 'draft', at: args.at, revision: 1 }],
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed transaction does not persist a change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-ledger-'));
  try {
    const ledger = createLedger(join(dir, 'state.json'));
    assert.throws(() => ledger.transact({ key: 'x', actor: 'a', action: 'x', at: '2026-09-23T00:00:00Z', apply(records) { records.bad = true; throw Error('failed'); } }));
    assert.equal(ledger.snapshot().revision, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
