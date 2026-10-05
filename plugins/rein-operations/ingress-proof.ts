import type { BackendProof } from './backend-transport.ts';

export type ProofFailureReason =
  | 'proof_unavailable'
  | 'proof_expired'
  | 'proof_ambiguous'
  | 'proof_scope_mismatch';

export interface IngressProofScope {
  platform: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  eventId: string;
}

export type ProofResolution =
  | { ok: true; proof: BackendProof }
  | { ok: false; reason: ProofFailureReason };

export interface IngressProofStore {
  recordRun(params: { runId: string; scope: IngressProofScope; proof: BackendProof; expiresAt: number }): void;
  resolveRun(params: { runId: string; scope: IngressProofScope }): ProofResolution;
  recordScope(params: { scope: IngressProofScope; sessionKey: string; proof: BackendProof; expiresAt: number }): void;
  resolveScope(params: { scope: IngressProofScope; sessionKey: string }): ProofResolution;
  bindToolCall(toolCallId: string, proof: BackendProof, expiresAt: number): void;
  resolveToolCall(toolCallId: string): ProofResolution;
  bindSession(sessionId: string, proof: BackendProof, expiresAt: number): 'bound' | 'in_flight';
  resolveSession(sessionId: string): ProofResolution;
  releaseSession(sessionId: string): void;
  forgetRun(runId: string): void;
  clear(): void;
  size(): number;
}

export const scopeKeyOf = (scope: IngressProofScope): string =>
  [scope.platform, scope.workspaceId, scope.channelId, scope.userId].join('\u0000');

const runKeyOf = (runId: string): string => `run\u0000${runId}`;
const scopeIndexKeyOf = (scope: IngressProofScope, sessionKey: string): string =>
  `scope\u0000${scopeKeyOf(scope)}\u0000${sessionKey}`;
const toolCallKeyOf = (toolCallId: string): string => `toolCall\u0000${toolCallId}`;
const sessionKeyOf = (sessionId: string): string => `session\u0000${sessionId}`;

interface RunEntry {
  kind: 'run';
  proof: BackendProof;
  scopeKey: string;
  eventId: string;
  expiresAt: number;
  ambiguous: boolean;
}

interface ScopeEntry {
  kind: 'scope';
  proof: BackendProof;
  scopeKey: string;
  eventId: string;
  expiresAt: number;
  ambiguous: boolean;
}

interface ToolCallEntry {
  kind: 'toolCall';
  proof: BackendProof;
  expiresAt: number;
}

interface SessionEntry {
  kind: 'session';
  proof: BackendProof;
  expiresAt: number;
  inFlight: boolean;
}

type Entry = RunEntry | ScopeEntry | ToolCallEntry | SessionEntry;

export interface CreateIngressProofStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

export function createIngressProofStore(options: CreateIngressProofStoreOptions = {}): IngressProofStore {
  const maxEntries = options.maxEntries ?? 256;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('ingress proof store config: maxEntries must be a positive integer');
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const sweep = (): void => {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  };

  const evictIfNeeded = (): void => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  const resolve = (entry: Entry | undefined): ProofResolution => {
    if (!entry) return { ok: false, reason: 'proof_unavailable' };
    if ((entry.kind === 'run' || entry.kind === 'scope') && entry.ambiguous) {
      return { ok: false, reason: 'proof_ambiguous' };
    }
    if (entry.expiresAt <= now()) return { ok: false, reason: 'proof_expired' };
    return { ok: true, proof: entry.proof };
  };

  return Object.freeze({
    recordRun({ runId, scope, proof, expiresAt }) {
      sweep();
      const key = runKeyOf(runId);
      const existing = entries.get(key);
      if (existing && existing.kind === 'run' && existing.expiresAt > now()) {
        if (existing.eventId !== scope.eventId || existing.scopeKey !== scopeKeyOf(scope)) {
          entries.set(key, { ...existing, ambiguous: true, expiresAt });
          return;
        }
      }
      entries.set(key, {
        kind: 'run',
        proof,
        scopeKey: scopeKeyOf(scope),
        eventId: scope.eventId,
        expiresAt,
        ambiguous: false,
      });
      evictIfNeeded();
    },

    resolveRun({ runId, scope }) {
      const entry = entries.get(runKeyOf(runId));
      if (!entry || entry.kind !== 'run') return { ok: false, reason: 'proof_unavailable' };
      const outcome = resolve(entry);
      if (!outcome.ok) return outcome;
      if (entry.scopeKey !== scopeKeyOf(scope)) return { ok: false, reason: 'proof_scope_mismatch' };
      return outcome;
    },

    recordScope({ scope, sessionKey, proof, expiresAt }) {
      sweep();
      const key = scopeIndexKeyOf(scope, sessionKey);
      const existing = entries.get(key);
      if (existing && existing.kind === 'scope' && existing.expiresAt > now()) {
        if (existing.eventId !== scope.eventId || existing.scopeKey !== scopeKeyOf(scope)) {
          entries.set(key, { ...existing, ambiguous: true, expiresAt });
          return;
        }
      }
      entries.set(key, {
        kind: 'scope',
        proof,
        scopeKey: scopeKeyOf(scope),
        eventId: scope.eventId,
        expiresAt,
        ambiguous: false,
      });
      evictIfNeeded();
    },

    resolveScope({ scope, sessionKey }) {
      const entry = entries.get(scopeIndexKeyOf(scope, sessionKey));
      if (!entry || entry.kind !== 'scope') return { ok: false, reason: 'proof_unavailable' };
      const outcome = resolve(entry);
      if (!outcome.ok) return outcome;
      if (entry.scopeKey !== scopeKeyOf(scope)) return { ok: false, reason: 'proof_scope_mismatch' };
      return outcome;
    },

    bindToolCall(toolCallId, proof, expiresAt) {
      sweep();
      entries.set(toolCallKeyOf(toolCallId), { kind: 'toolCall', proof, expiresAt });
      evictIfNeeded();
    },

    resolveToolCall(toolCallId) {
      return resolve(entries.get(toolCallKeyOf(toolCallId)));
    },

    bindSession(sessionId, proof, expiresAt) {
      sweep();
      const key = sessionKeyOf(sessionId);
      const existing = entries.get(key);
      if (existing && existing.kind === 'session' && existing.expiresAt > now() && existing.inFlight) {
        return 'in_flight';
      }
      entries.set(key, { kind: 'session', proof, expiresAt, inFlight: true });
      evictIfNeeded();
      return 'bound';
    },

    resolveSession(sessionId) {
      return resolve(entries.get(sessionKeyOf(sessionId)));
    },

    releaseSession(sessionId) {
      const key = sessionKeyOf(sessionId);
      const entry = entries.get(key);
      if (entry && entry.kind === 'session') entries.delete(key);
    },

    forgetRun(runId) {
      entries.delete(runKeyOf(runId));
    },

    clear() {
      entries.clear();
    },

    size() {
      sweep();
      return entries.size;
    },
  });
}
