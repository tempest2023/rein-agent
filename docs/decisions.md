# Decision register

This register separates what a person with authority has confirmed for the P0 v0.1 slice from product
suggestions and deferred work. "Confirmed" is not inherited from an earlier draft, an absent reply,
or a recommendation elsewhere in the PRD. Record decisions with authority, date, policy version and
effective date.

## Confirmed

Confirmed by the user on 2026-09-24 for the early Web3 DAO period:

| ID | Confirmed decision |
| --- | --- |
| D01 | OpenClaw is the Agent runtime. It is vendored as a pinned, read-only git submodule at `vendor/openclaw`, and Rein behaviour lives in Rein-owned plugin packages under `plugins/`. |
| D02 | P0 uses Slack as its single chat platform; members mention the Agent in Slack conversations. A second platform (for example Discord) stays a later phase. |
| D03 | During the early Web3 DAO period, members, directors and available funds stay in the organization's own database (the Foundation site's Supabase project, with isolated `dev_*` and `prod_*` table sets). The Agent reaches that data only through one authenticated backend service and holds no database credential of its own. A Slack account acts only after a canonical verified link to a community record. |
| D04 | P0 Board voting is **approve-only**. Every member on the frozen eligible list holds one equal weight and may record explicit approvals; there is no reject choice, and `abstain` means casting no approvals. The candidate with the highest approval count wins. A round in which every ballot abstains produces no winner. |
| D05 | A funding approval is a decision record. It does not move money, reserve money, or commit a payment. Available funds are read from a human-entered snapshot. |
| D06 | Only members with active Contributor status may formally submit proposals or serve as activity lead; only eligible Board members may vote. |
| D07 | People execute events offline. The Agent does not sign, pay, grant status, or change voting weight. |
| D08 | The Agent assembles each vote round from a pool of recent proposals plus proposals that were not selected in an earlier round. Each proposal type carries its own candidate cap, chosen by operators and applied in operation relative to the eligible voter count; the Events cap is configured as 10 in the current example, and the number is not a universal fixed policy. A round with a single candidate is a valid round. |
| D09 | The maximum number of approvals one voter may cast is configured per proposal type: usually one, and more than one where a type allows it. |
| D10 | After a result, feedback may change an accepted proposal, but a change to budget, location, personnel or the major event flow requires at least one current Board member approval before the changed version takes effect. |
| D11 | The ordinary side of D10 needs no second approval: the Agent may accept a reasonable revision that moves only the title or the summary on a selected proposal and make it the effective version itself, with no separate Board approval. D10's material gate keeps its full force for budget, location, personnel and the major event flow, and for a schedule change in the current implementation. Together, D10 and D11 are the rule the P0 v0.1 slice follows. |

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
| D12 | Channel roles are separated. Slack is the internal governance surface for the core circle, meaning core board members and core contributors: Board voting, fund review and event review happen there and nowhere else. Discord is the general-participant surface, and in the early Agent period it carries onboarding, free-resource navigation and participation paths only, with no governance action. Slack remains the single P0 platform. Discord is a later, separate scope: no Discord server is connected, nothing about it is implemented, and no v0.1 step depends on it. A binding made on one platform or space never confers rights on another, so a Discord identity link never confers Slack governance rights and one platform's role or channel membership never substitutes for another platform's eligibility check. No generic cross-channel business framework is planned. |

The channel split is a recorded boundary, not a new capability. It narrows Slack to the core
circle, restates Discord as general-participant onboarding only, and leaves the identity-link rules
in D03 unchanged: a platform account acts only after an explicit link to a community record, and
that binding is scoped to the platform and space it was made in. D13 later narrows this for the
Slack v0.1 alone: identity there is resolved by the authenticated backend from canonical verified
links.

Recorded 2026-09-30, superseding the earlier Slack profile-email mechanism:

| ID | Confirmed decision |
| --- | --- |
| D13 | A Slack sender's identity is resolved only by the authenticated backend service, from canonical verified links it holds. The Agent holds no database credential, performs no database work and never resolves identity itself: it relays the inbound tuple (platform, workspace, user, channel, event) to the backend, receives a private, backend-signed assertion bound to that tuple and to the calling Agent, and presents that proof on the identity-resolve and operation calls it makes. There is no profile-email path anywhere in the Agent: it requests no Slack profile, reads no email, and keeps no `users.info` lookup, no `users:read` / `users:read.email` bot scope and no `identityEmailMatch` option. A display name, platform label, chat-claimed email or claimed role is still not evidence of identity, and a sender the backend cannot resolve stays unidentified. P0 permits one verified Slack identity per contact; multiple Slack accounts and account migration are deferred to P2. Cross-platform identity, every other platform, and a generic cross-channel business framework stay deferred and unimplemented (D12). |

D13 was recorded on 2026-09-30 and replaces the earlier profile-email mechanism outright: the Agent
does not resolve identity, and no email match exists in it. It changes no other rule: Contributor
and Board eligibility still come from the backend's current role records (D06), and a resolved
sender still needs an approved channel and every other guard. The decision authorizes no
installation on its own. No Slack workspace is connected in this repository's local development
framing, the Agent is not deployed, and nothing here is a live acceptance; the transport and
identity path are exercised by local synthetic tests only.

## P0 v0.1 scope

The v0.1 slice is one vertical slice on real data, not the full lifecycle described in the PRD:

**Supersession note (2026-09-27).** Two statements in the copied PRD draft are narrower than the
confirmed v0.1 slice and must not be read as current requirements. The PRD phase table describes the P0
deliverable as "the decision is recorded **and posted** without the founder driving it"
(`docs/PRD-agent-community-operations.md`, §5), and the direction summary at
`docs/PRD-agent-community-operations-zh.md` carries the same wording. The confirmed scope below is
the authority: no registered tool posts a message, so a result is recorded and returned to the
calling turn only, and the Board reads it there or asks again. PRD §2.3 step 3 already states that
posting is not implemented; the phase table simply predates that narrowing. A second statement, the
manual team/user link prerequisite, is superseded for the Slack v0.1 slice by D13's backend-resolved
canonical verified links.

1. **Slack identity.** The Agent never resolves identity itself. It relays the inbound tuple
   (platform, workspace, user, channel, event) to the authenticated backend, which returns a private
   signed assertion; the backend resolves the acting contact and its current role from canonical
   verified links and binds the assertion to that sender, channel and caller (D13). The proof is a
   private closure: it is never a tool argument, never a tool result and never a status field, and
   no tool accepts a model-supplied actor. A sender the backend cannot resolve stays unidentified
   and may ask questions but cannot submit, vote, or act. An unlinked sender can start a binding:
   the Agent returns the website URL the backend issues, the person completes the step in a browser,
   and they carry a short code back that the Agent forwards to the backend to finish the link. The
   Agent asks for no email address, and operator configuration lists the approved workspaces and
   their native channel IDs.
2. **Contributor proposal.** A linked, active Contributor submits a simple funding proposal in
   Slack; the Agent records the version its author confirmed through the backend.
3. **Board approval vote and result.** Eligible directors receive the candidate pool in Slack and
   record explicit approvals or abstain; there is no reject choice, and abstain casts no approvals.
   The count follows D04, D08 and D09. The Agent records the outcome, participation and the governing
   rule and returns them to the calling turn. Posting a result back to Slack is **not implemented**:
   the current result tool only returns the result and does not post a message.

   A round is decided by the backend at or after its closing time, not by the caller: before the
   deadline the result tool reports `provisional`, `official: false` and no count or winner, and at
   or after it the backend stores the outcome. A tie and a round with no approvals both store
   `outcome: 'no_winner'` with a null winner and no spending authority; the recorded approval counts
   come back with it so the Board can read the record itself.
4. **Read-only funds snapshot.** The Agent may display the latest human-entered available-funds
   snapshot with its currency and record time. It cannot create, edit, reserve, or spend funds.

Local read-only building blocks for steps 1 and 4 exist (`backend-transport.ts`,
`backend-db-adapter.ts`, `governance-read-tools.ts`) and are covered by tests, and the two base
migrations are applied to the linked `BeneficenceProtocol` project, defining both the `dev_*` and
`prod_*` objects (verified read-only on 2026-09-27 with `supabase migration list --linked`), but the
Agent holds no database credential, makes no direct database call and no registered tool has
exercised the backend end to end. The registered write tools for steps 2 and 3 exist
(`foundation-db-writer.ts`, `governance-write-tools.ts`, `vote-tally.ts`) and register only under an
explicit `foundationDb` config block. `rein_poll_open`
takes its candidate cap from the stored vote type and assembles the pool itself from stored
proposals, offering recently unselected ones too, so no caller supplies candidates, a cap or an
option label; `rein_poll_vote` accepts approvals only, bounded by the poll's own approval limit, and
an empty list is the abstention. The `approvedProposalIds` argument replaces the earlier
curator-supplied option list, and the backend freezes the candidate list and both limits at insert
time, so D04, D08 and D09 now have a registered code path. The concrete cap and approval-budget
values are still operator configuration, and no Slack workspace and no registered tool has
exercised any of it against the backend.

Feedback revisions after a result have a registered path too: the backend's
`<env>_rein_proposal_revisions` table records a comment or a suggested revision, and a revision that
moves a material field is refused with `revision_not_approved` until a current director records an
approval through the backend's `approve_proposal_revision` operation. Registering those paths in
`index.ts` is what turned the C15 governance gate into an Agent-facing workflow, in
`proposal-feedback-tools.ts`:
`rein_proposal_comment_suggest` records a comment or a suggested revision,
`rein_revision_approve` records a director's approval, and `rein_revision_apply` makes a
revision the effective version. Applying is where D11 shows: a revision that moves only the title or
the summary is applied by the Agent with no separate approval, while a material revision is refused
with `revision_not_approved` until an approval is recorded. Those paths are exercised only by
synthetic tests, and no Slack round has used them.

Work is out of v0.1 scope unless it is required to finish those four steps, including local modules
that already exist. A local deterministic module is not an approval of the policy it encodes, and
it stays unregistered until that policy is confirmed.

## Proposed, not adopted

| Item | Proposed v0.1 assumption |
| --- | --- |
| Tie rule | When the highest approval count is shared by more than one candidate, the round must not be marked as an official winner and must not be silently broken by the Agent. How such a round is decided is not confirmed; the user has not yet chosen between "no winner", a chair casting vote, or another tie rule. This is separate from the confirmed all-abstain rule in D04: an all-abstain round has no winner by rule. |

The following are also unresolved and must not be presented as adopted: the exact eligible voter
list and its freeze point; the concrete per-type candidate cap and per-type approval budget values;
the voting window length; channel and space mapping; and who may see an individual ballot.

## Deferred from v0.1

- Weighted voting, participation and quorum thresholds, recusal and conflict-of-interest rules.
- Allocating one budget across competing proposals, ranking and prioritisation rules.
- Payment, reimbursement, settlement and reconciliation.
- Activity spaces, preparation checklists, proactive reminders, outcome collection and articles.
- Website publishing and social media distribution.
- Weekly operations summaries, exception handling, oversight and pause controls.
- A second chat platform (the Discord general-participant scope in D12), cross-platform identity
  beyond the canonical verified links in D13, and on-chain or DAO governance migration.
- Video, contracts, token issuance and on-chain voting.

## Recorded technical decisions

- **Naming and the rename migration.** A pre-launch review asked for the stage-based naming to be
  removed from tools, tables, config and skills. The plugin and configuration now use the stable
  v0.1 names: the twelve tools `rein_member_status`, `rein_funds`, `rein_poll_candidates`,
  `rein_vote_type_resolve`, `rein_governance_proposal_submit`, `rein_poll_open`, `rein_poll_vote`,
  `rein_poll_result`, `rein_proposal_collect`, `rein_proposal_comment_suggest`, `rein_revision_approve`
  and `rein_revision_apply`, and the `foundationDb` config block. The two base migrations were
  already applied to the linked `BeneficenceProtocol` project under their original stage-prefixed
  names, so those tables and RPCs could not be renamed in place: the rename needed a forward
  migration. That migration is `20260927110000_rein_governance_names.sql`, ordered after the
  committed `20260927103000`, and it is **applied** to the linked project as of 2026-09-28, so the
  new names exist there. The transition compatibility views and RPC wrappers it created were removed
  by the later applied `20260929045543_remove_stage_compatibility_objects.sql`, so only the stable
  names remain. Applying it is not evidence that the Agent has used the new names live. The
  interfaces are listed in [provider contracts](integration-contracts.md#naming-and-the-rename-migration).
  Source file and test filenames now use the stable v0.1 stems as well.

- **The Agent talks to one authenticated backend service.** The Agent holds no database credential
  and performs no database work: every governance read and write, identity resolution and identity
  binding is one authenticated call to the Foundation backend API (`backend-transport.ts`,
  `backend-db-adapter.ts`, `ingress-proof.ts`). Events arrive as an ingress tuple and come back as a
  private, backend-signed assertion bound to the platform, workspace, user, channel, event and the
  calling Agent. That proof is a private closure: it is never a tool argument, never a tool result
  and never a status field, and no tool accepts a model-supplied actor. Identity comes only from
  canonical verified links held by the backend; the Agent asks for no email address, and starting a
  bind returns a website URL the person opens while completing it takes only the short code the
  person carries back.

- **The `foundationDb` config block now names the backend, not a database.** It carries `enabled`,
  `platform` (`'slack'`), `workspaces` (each entry an `id` with a non-empty native channel ID list),
  `proposalChannelIds`, `boardChannelIds`, `backendApiBaseUrlEnvVar`, `agentCallerIdEnvVar`,
  `agentCredentialEnvVar` and the optional `voteTypeAliases`. The earlier keys `slackTeamId`,
  `environment`, `supabaseUrlEnvVar`, `supabaseServiceKeyEnvVar`, `identityEmailMatch` and
  `slackBotTokenEnvVar` are removed: there is no Supabase service key and no Slack profile-email
  lookup in the Agent.

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
- The registered governance tools return their result to the calling turn. No tool posts to Slack on its
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
| The v0.1 voting window length | First real vote |
| Tie rule when the highest approval count is shared | First real vote that ties |
| Who may see an individual ballot versus the published result | First real vote |
| Which backend environment (`dev_*` or `prod_*`) the v0.1 slice may call, and what data the backend serves there. The two migrations in the sibling repo `tempest2023/ReinProtocolFoundation` (`supabase/migrations/20260924094436_rein_slack_identity_and_fund_snapshots.sql` and `supabase/migrations/20260924095705_rein_mvp_proposals_polls_ballots.sql`) are committed on the PR #13 branch (PR #13 head `78281fa`, rename commit `08542ad09932a4cefb62f230a9bdcf9fd4d32dfe`, first authored at `4bd5ce8`) and applied to the linked `BeneficenceProtocol` project (verified read-only 2026-09-27 with `supabase migration list --linked`). Each creates both the `dev_*` and `prod_*` objects, so the `prod_*` schema already exists; the open question is data and backend use, not schema. A third sibling migration, `20260927103000_rein_mvp_ballot_cast_at_db_clock.sql`, was committed at `32977bfb` and, together with the fourth, rename migration `20260927110000_rein_governance_names.sql`, is **applied** to the linked project as of 2026-09-28; the compatibility views and wrappers were removed by the later applied `20260929045543_remove_stage_compatibility_objects.sql`. The live code path is still unverified, and the Agent itself holds no database credential. | Enabling v0.1 against production data |
| The backend service base URL, the registered Agent caller ID and the Agent credential, each named by its own server environment variable (`foundationDb.backendApiBaseUrlEnvVar`, `foundationDb.agentCallerIdEnvVar`, `foundationDb.agentCredentialEnvVar`), plus the approved workspace IDs and native channel IDs the `foundationDb.workspaces` list carries | Enabling the Slack identity and governance path |
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
