# Decision register

This register separates what a person with authority has confirmed for the P0 MVP from product
suggestions and deferred work. "Confirmed" is not inherited from an earlier draft, an absent reply,
or a recommendation elsewhere in the PRD. Record decisions with authority, date, policy version and
effective date.

## Confirmed

Confirmed by the user on 2026-09-24 for the early Web3 DAO period:

| ID | Confirmed decision |
| --- | --- |
| D01 | OpenClaw is the Agent runtime. It is vendored as a pinned, read-only git submodule at `vendor/openclaw`, and Rein behaviour lives in Rein-owned plugin packages under `plugins/`. |
| D02 | P0 uses Slack as its single chat platform; members mention the Agent in Slack conversations. A second platform (for example Discord) stays a later phase. |
| D03 | During the early Web3 DAO period, members, directors and available funds stay in the organization's own database (the Foundation site's Supabase project, with isolated `dev_*` and `prod_*` table sets). A Slack account acts only after an explicit link to a community record. |
| D04 | P0 Board voting is **approve-only**. Every member on the frozen eligible list holds one equal weight and may record explicit approvals; there is no reject choice, and `abstain` means casting no approvals. The candidate with the highest approval count wins. A round in which every ballot abstains produces no winner. |
| D05 | A funding approval is a decision record. It does not move money, reserve money, or commit a payment. Available funds are read from a human-entered snapshot. |
| D06 | Only members with active Contributor status may formally submit proposals or serve as activity lead; only eligible Board members may vote. |
| D07 | People execute events offline. The Agent does not sign, pay, grant status, or change voting weight. |
| D08 | The Agent assembles each vote round from a pool of recent proposals plus proposals that were not selected in an earlier round. Each proposal type carries its own candidate cap, chosen by operators and applied in operation relative to the eligible voter count; the Events cap is configured as 10 in the current example, and the number is not a universal fixed policy. A round with a single candidate is a valid round. |
| D09 | The maximum number of approvals one voter may cast is configured per proposal type: usually one, and more than one where a type allows it. |
| D10 | After a result, feedback may change an accepted proposal, but a change to budget, location, personnel or the major event flow requires at least one current Board member approval before the changed version takes effect. |
| D11 | The ordinary side of D10 needs no second approval: the Agent may accept a reasonable revision that moves only the title or the summary on a selected proposal and make it the effective version itself, with no separate Board approval. D10's material gate keeps its full force for budget, location, personnel and the major event flow, and for a schedule change in the current implementation. Together, D10 and D11 are the rule the P0 MVP follows. |

The approve-only shape, the candidate pool, the per-type caps and the post-result change gate above were
confirmed by the user on 2026-09-24. The cap numbers and the per-type approval budgets are configuration
and remain open until an operator records them.

D11 was confirmed by the user on 2026-09-24 and supersedes the earlier unresolved wording in this
register and in the PRDs: an ordinary title or summary revision is no longer an open question. The
rule is exercised by local synthetic tests only. A revision is a request, never an authorization:
neither an ordinary revision nor a material approval moves, reserves or pays money.

Confirmed by the user on 2026-09-25 as a scope decision:

| ID | Confirmed decision |
| --- | --- |
| D12 | Channel roles are separated. Slack is the internal governance surface for the core circle, meaning core board members and core contributors: Board voting, fund review and event review happen there and nowhere else. Discord is the general-participant surface, and in the early Agent period it carries onboarding, free-resource navigation and participation paths only, with no governance action. Slack remains the single P0 MVP platform. Discord is a later, separate scope: no Discord server is connected, nothing about it is implemented, and no MVP step depends on it. Identity links stay separate per platform and per space, so a Discord identity link never confers Slack governance rights and one platform's role or channel membership never substitutes for another platform's eligibility check. No generic cross-channel business framework is planned. |

The channel split is a recorded boundary, not a new capability. It narrows Slack to the core
circle, restates Discord as general-participant onboarding only, and leaves the identity-link rules
in D03 unchanged: a platform account acts only after an explicit link to a community record, and
that link is scoped to the platform and space it was made in.

## P0 MVP scope

The MVP is one vertical slice on real data, not the full lifecycle described in the PRD:

1. **Slack identity.** An administrator links one trusted Slack team/user pair to an existing
   community record. Unlinked senders may ask questions but cannot submit, vote, or act. One
   installation serves exactly one Slack workspace: the runtime's trusted tool context carries the
   sender and the channel but no team ID, so the team is fixed operator configuration.
2. **Contributor proposal.** A linked, active Contributor submits a simple funding proposal in
   Slack; the Agent stores the version its author confirmed.
3. **Board approval vote and result.** Eligible directors receive the candidate pool in Slack and
   record explicit approvals or abstain; there is no reject choice, and abstain casts no approvals.
   The count follows D04, D08 and D09. The Agent records the outcome, participation and the governing
   rule and returns them to the calling turn. Posting a result back to Slack is **not implemented**:
   the current result tool only returns the result and does not post a message.

   A round is decided by the database at or after its closing time, not by the caller: before the
   deadline the result tool reports `provisional`, `official: false` and no count or winner, and at
   or after it the finalize RPC stores the outcome. A tie and a round with no approvals both store
   `outcome: 'no_winner'` with a null winner and no spending authority; the recorded approval counts
   come back with it so the Board can read the record itself.
4. **Read-only funds snapshot.** The Agent may display the latest human-entered available-funds
   snapshot with its currency and record time. It cannot create, edit, reserve, or spend funds.

Local read-only building blocks for steps 1 and 4 exist (`foundation-db-reader.ts`,
`mvp-read-tools.ts`) and are covered by tests, but no live database is connected. The registered
write tools for steps 2 and 3 exist (`foundation-db-writer.ts`, `mvp-write-tools.ts`,
`mvp-vote-tally.ts`) and register only under an explicit `mvp` config block. `rein_mvp_poll_open`
takes its candidate cap from the stored vote type and assembles the pool itself from stored
proposals, offering recently unselected ones too, so no caller supplies candidates, a cap or an
option label; `rein_mvp_vote` accepts approvals only, bounded by the poll's own approval limit, and
an empty list is the abstention. The `approvedProposalIds` argument replaces the earlier
curator-supplied option list, and the database freezes the candidate list and both limits at insert
time, so D04, D08 and D09 now have a registered code path. The concrete cap and approval-budget
values are still operator configuration, and no live database or Slack workspace has exercised any
of it.

Feedback revisions after a result have a registered path too:
`rein_mvp_proposal_revisions` records a comment or a suggested revision, and a revision that moves a
material field is refused with `revision_not_approved` until a current director records an approval
through the `rein_mvp_approve_revision` RPC. Registering those paths in `index.ts` is what turned
the C15 database gate into an Agent-facing workflow, in `mvp-feedback-tools.ts`:
`rein_mvp_proposal_comment_suggest` records a comment or a suggested revision,
`rein_mvp_revision_approve` records a director's approval, and `rein_mvp_revision_apply` makes a
revision the effective version. Applying is where D11 shows: a revision that moves only the title or
the summary is applied by the Agent with no separate approval, while a material revision is refused
with `revision_not_approved` until an approval is recorded. Those paths are exercised only by
synthetic tests; no SQL has been applied and no Slack round has used them.

Work is out of MVP scope unless it is required to finish those four steps, including local modules
that already exist. A local deterministic module is not an approval of the policy it encodes, and
it stays unregistered until that policy is confirmed.

## Proposed, not adopted

| Item | Proposed MVP assumption |
| --- | --- |
| Tie rule | When the highest approval count is shared by more than one candidate, the round must not be marked as an official winner and must not be silently broken by the Agent. How such a round is decided is not confirmed; the user has not yet chosen between "no winner", a chair casting vote, or another tie rule. This is separate from the confirmed all-abstain rule in D04: an all-abstain round has no winner by rule. |

The following are also unresolved and must not be presented as adopted: the exact eligible voter
list and its freeze point; the concrete per-type candidate cap and per-type approval budget values;
the voting window length; channel and space mapping; and who may see an individual ballot.

## Deferred from the MVP

- Weighted voting, participation and quorum thresholds, recusal and conflict-of-interest rules.
- Allocating one budget across competing proposals, ranking and prioritisation rules.
- Payment, reimbursement, settlement and reconciliation.
- Activity spaces, preparation checklists, proactive reminders, outcome collection and articles.
- Website publishing and social media distribution.
- Weekly operations summaries, exception handling, oversight and pause controls.
- A second chat platform (the Discord general-participant scope in D12), cross-platform identity, and
  on-chain or DAO governance migration.
- Video, contracts, token issuance and on-chain voting.

## Recorded technical decisions

- The vendored runtime is the official source checkout, not a fork. It is pinned by the
  `vendor/openclaw` submodule pointer and updated only through the reviewed flow in
  [upstream](upstream.md). Read the live commit with `git ls-files -s vendor/openclaw` or
  `git ls-tree HEAD vendor/openclaw`; do not restate a commit hash in documents that can drift.
- Rein behaviour belongs in Rein-owned plugin packages under `plugins/`. No Rein commit edits
  `vendor/openclaw/src/` or `vendor/openclaw/extensions/`; `.github/workflows/openclaw.yml` fails
  when tracked upstream files change.
- `rein_status` reports that live automation is disabled. `rein_simulate_proposal` and
  `rein_simulate_vote` exercise synthetic inputs only. Deterministic local business cores do not
  authorize live actions; trusted adapters and approved policies remain prerequisites.
- Four proposal lifecycle tools use OpenClaw's v2 trusted sender context and the local ledger only
  when an operator explicitly configures one platform, native channel scope and storage path. No
  platform or channel is preselected here; formal eligibility still requires an authoritative
  member record and verified identity link. These tools do not register voters, approve policy,
  reserve funds or publish externally.
- The registered MVP tools return their result to the calling turn. No tool posts to Slack on its
  own, so the Agent does not "post the result back to Slack" in the current build. Any future
  posting must persist intent plus an idempotency key before delivery.
- Development plugin entries may point at TypeScript source because the runtime is a local source
  checkout. Publishing requires a built JavaScript entry, removing `private`, and verifying the
  packed install first.

## Unresolved

All items below are unresolved. PRD suggestions remain suggestions.

| Decision | Needed before |
| --- | --- |
| Slack workspace identity, app scopes, channel IDs and space mapping | Any Slack integration |
| Which Slack channels are core-only, and who verifies core board member and core contributor status in them | Configuring the Slack governance surface |
| Discord server, app scopes, identity-link owner, and the review that would open any Discord scope beyond onboarding, free-resource navigation and participation paths | Connecting any general-participant surface |
| Which community records count as active Contributor and as director, and the frozen voter list | Formal proposals and votes |
| The concrete per-type candidate cap and the eligible-voter-count basis for each proposal type | First assembled real round |
| The concrete per-type maximum approvals per voter, and which types allow more than one | First assembled real round |
| The MVP voting window length | First real vote |
| Tie rule when the highest approval count is shared | First real vote that ties |
| Who may see an individual ballot versus the published result | First real vote |
| Whether the local migration at the sibling repo `BeneficenceProtocol/supabase/migrations/20260924094436_rein_slack_identity_and_fund_snapshots.sql` is reviewed, committed and applied to the live `dev_*` and `prod_*` tables | First real Slack link and funds read |
| Zero-budget activity scope and exception authority | Automatic approval |
| Cadence, timezone and notification lead time | Selection rounds |
| Currency, available-funds update owner and reconciliation cadence | Reading or committing funds |
| Payment, reimbursement and reconciliation owners | Funded activities |
| Material rights, retention/deletion and owner confirmation | Real evidence collection and publishing |
| Exception owners, deputies, appeal and emergency process | Pilot |
| Reminder cadence, quiet hours and snoozes | Proactive reminders |
| When and how often to bump the pinned OpenClaw commit; who reviews it | Regular runtime maintenance |
| Storage, hosting and website contracts | Technical implementation |
| License and public/private repository policy | Public release |

Do not infer agreement from an absent response. Amend running governance only through the
authorized exception process, never by silently changing its snapshot.
