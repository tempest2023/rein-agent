// Operator-authored display names for the configured vote types, and the deterministic phrase
// resolver behind the read-only `rein_vote_type_resolve` tool.
//
// This module is pure: it reads no configuration source, opens no socket and writes nothing. Its
// only vocabulary is what the operator wrote into the `foundationDb.voteTypeAliases` config block. A phrase
// is normalized conservatively (Unicode NFKC, trim, internal whitespace collapsed to one space,
// case folded) and then compared by exact equality only. It never invents a synonym, never
// translates, never picks a closest match, and never names a type code the operator did not write
// down next to a phrase a member actually used.
//
// Scope: PRD R02 (a display name never establishes identity) and D06 (only members with active
// Contributor status propose or lead). The resolution itself is an operator-configuration answer:
// it grants no role, lists no proposal and authorizes no spending.

/** Lower snake case, exactly the shape the operator's vote type table stores. */
export const VOTE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Longest display name or alias one configuration entry may carry. */
export const MAX_VOTE_TYPE_LABEL_LENGTH = 120;
/** Upper bound on the number of labelled types; the map is operator configuration, not caller input. */
export const MAX_VOTE_TYPE_LABELS = 200;
/** Upper bound on the aliases one type may declare. */
export const MAX_VOTE_TYPE_ALIASES = 32;

/** One operator-authored label: the type code, the human name and any extra names for it. */
export interface VoteTypeLabel {
  readonly voteType: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
}

/** The operator's whole label map, in the order the configuration declared it. */
export type VoteTypeLabelMap = readonly VoteTypeLabel[];

export class VoteTypeLabelConfigError extends Error {
  constructor(message: string) {
    super(`voteTypeAliases: ${message}`);
    this.name = 'VoteTypeLabelConfigError';
  }
}

/**
 * Normalize one phrase for comparison. Conservative by construction: Unicode NFKC composition, a
 * trim, every run of whitespace collapsed to a single space, and case folding. It deliberately
 * removes nothing else - no punctuation stripping, no stemming, no translation - so two phrases
 * compare equal only when a person would read them as the same written words.
 *
 * JavaScript exposes no full Unicode case folding; `toLowerCase` is the approximation, and it can
 * only ever merge labels that differ in case alone, which the caller then reports as ambiguous
 * instead of choosing between them.
 */
export function normalizeVoteTypePhrase(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readLabel(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new VoteTypeLabelConfigError(`${field} must be a name string`);
  const label = value.trim();
  if (!label) throw new VoteTypeLabelConfigError(`${field} must not be empty`);
  if (label.length > MAX_VOTE_TYPE_LABEL_LENGTH) {
    throw new VoteTypeLabelConfigError(`${field} must be at most ${MAX_VOTE_TYPE_LABEL_LENGTH} characters`);
  }
  return label;
}

/**
 * Validate the operator's `voteTypeAliases` block. An absent or null block is an empty map, which
 * resolves nothing; anything else malformed is a configuration error rather than a silently ignored
 * typo, because a dropped label would quietly make a member's own words unresolvable.
 *
 * A name two different types both claim is *not* an error here: resolution reports it as ambiguous,
 * so the operator's overlap reaches the caller as a question instead of a guess.
 */
export function parseVoteTypeLabelConfig(value: unknown): VoteTypeLabelMap {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!isPlainObject(value)) {
    throw new VoteTypeLabelConfigError('must be an object keyed by configured vote type code');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_VOTE_TYPE_LABELS) {
    throw new VoteTypeLabelConfigError(`must name at most ${MAX_VOTE_TYPE_LABELS} vote types`);
  }
  const labels: VoteTypeLabel[] = [];
  for (const [voteType, entry] of entries) {
    if (!VOTE_TYPE_PATTERN.test(voteType)) {
      throw new VoteTypeLabelConfigError(
        `"${voteType}" must be one lower snake case vote type such as event_single`,
      );
    }
    if (!isPlainObject(entry)) {
      throw new VoteTypeLabelConfigError(`${voteType} must be an object with a displayName`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'displayName' && key !== 'aliases') {
        throw new VoteTypeLabelConfigError(
          `${voteType}.${key} is not read; only displayName and aliases are`,
        );
      }
    }
    if (!Object.hasOwn(entry, 'displayName')) {
      throw new VoteTypeLabelConfigError(`${voteType} must carry a displayName`);
    }
    const displayName = readLabel(entry.displayName, `${voteType}.displayName`);
    let aliases: readonly string[] = Object.freeze([]);
    if (entry.aliases !== undefined && entry.aliases !== null) {
      if (!Array.isArray(entry.aliases)) {
        throw new VoteTypeLabelConfigError(`${voteType}.aliases must be an array of names`);
      }
      if (entry.aliases.length > MAX_VOTE_TYPE_ALIASES) {
        throw new VoteTypeLabelConfigError(
          `${voteType}.aliases must list at most ${MAX_VOTE_TYPE_ALIASES} names`,
        );
      }
      aliases = Object.freeze(
        entry.aliases.map((alias, index) => readLabel(alias, `${voteType}.aliases[${index}]`)),
      );
    }
    labels.push(Object.freeze({ voteType, displayName, aliases }));
  }
  return Object.freeze(labels);
}

/** The outcome of matching one phrase against the operator's labels. No case picks a type by guess. */
export type VoteTypePhraseResolution =
  | { readonly status: 'resolved'; readonly voteType: string; readonly displayName: string }
  | { readonly status: 'ambiguous'; readonly matches: VoteTypeLabelMap }
  | { readonly status: 'unmapped' }
  | { readonly status: 'invalid' };

/**
 * Match one phrase against the operator's display names and aliases by exact equality after
 * normalization. Exactly one configured type resolves; two or more are reported as ambiguous with
 * no type chosen; none is reported as unmapped. A phrase carrying no non-whitespace character is
 * `invalid` rather than unmapped, so a blank turn is never answered with a type directory.
 */
export function resolveVoteTypePhrase(
  phrase: unknown,
  labels: VoteTypeLabelMap,
): VoteTypePhraseResolution {
  if (typeof phrase !== 'string') return { status: 'invalid' };
  const needle = normalizeVoteTypePhrase(phrase);
  if (!needle) return { status: 'invalid' };
  const matches = labels.filter(
    label =>
      normalizeVoteTypePhrase(label.displayName) === needle ||
      label.aliases.some(alias => normalizeVoteTypePhrase(alias) === needle),
  );
  if (matches.length === 0) return { status: 'unmapped' };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  const [match] = matches;
  return { status: 'resolved', voteType: match.voteType, displayName: match.displayName };
}

/**
 * The operator's display name for one stored type, or null when the operator wrote none. Used to
 * render a clarification list in the operator's own words without inventing a name for a type that
 * has none; the caller decides what to show in that case.
 */
export function displayNameForVoteType(labels: VoteTypeLabelMap, voteType: string): string | null {
  for (const label of labels) {
    if (label.voteType === voteType) return label.displayName;
  }
  return null;
}
