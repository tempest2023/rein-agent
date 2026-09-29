import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class LedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// A small local rehearsal ledger. One JSON file contains projections, receipts and audit
// together, so a completed transaction cannot leave them at different revisions.
export function createLedger(path) {
  const file = resolve(path);
  const lock = `${file}.lock`;
  const empty = () => ({ revision: 0, records: {}, receipts: {}, audit: [] });
  const read = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  };
  const snapshot = () => structuredClone(read());
  const transact = ({ key, actor, action, at, apply }) => {
    if (![key, actor, action, at].every(value => typeof value === 'string' && value.trim())) {
      throw new Error('key, actor, action and at are required');
    }
    if (!Number.isFinite(Date.parse(at))) throw new Error('at must be a timestamp');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive directory creation prevents overlapping gateway writes. A contending caller
    // receives EEXIST and must retry later; a stale lock needs operator inspection.
    mkdirSync(lock);
    try {
      const state = read();
      if (Object.hasOwn(state.receipts, key)) {
        const previous = state.receipts[key];
        if (previous.actor !== actor || previous.action !== action) throw new LedgerError('idempotency_conflict', 'idempotency key reused for another operation');
        return structuredClone(previous);
      }
      const records = structuredClone(state.records);
      const result = apply(records);
      const receipt = { key, actor, action, at, revision: state.revision + 1, result };
      const next = {
        revision: receipt.revision,
        records,
        receipts: { ...state.receipts, [key]: receipt },
        audit: [...state.audit, { key, actor, action, at, revision: receipt.revision }],
      };
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = openSync(temp, 'wx', 0o600);
        try { writeFileSync(handle, JSON.stringify(next) + '\n'); fsyncSync(handle); }
        finally { closeSync(handle); }
        renameSync(temp, file);
        const directory = openSync(dirname(file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } finally { rmSync(temp, { force: true }); }
      return structuredClone(receipt);
    } finally { rmSync(lock, { recursive: true, force: true }); }
  };
  return { snapshot, transact };
}
