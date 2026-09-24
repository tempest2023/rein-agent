# Decision register

Confirmed: OpenClaw as the runtime; official OpenClaw source vendored as a pinned git submodule at `vendor/openclaw`; Rein development plugin-first, with upstream tracked files left unmodified; Contributor-only formal proposals; Board allocation of all requested organization funds; weighted voting; agent-led follow-up; humans execute offline; image/text social publishing later.

Recorded technical decisions:

- The vendored runtime is the official source checkout, not a fork. It is pinned by the
  `vendor/openclaw` submodule pointer and updated only through the reviewed flow in
  [upstream](upstream.md). Read the live commit with `git ls-files -s vendor/openclaw` or
  `git ls-tree HEAD vendor/openclaw`; do not restate a commit hash in documents that can drift.
- Rein behaviour belongs in Rein-owned plugin packages under `plugins/`. No Rein commit edits
  `vendor/openclaw/src/` or `vendor/openclaw/extensions/`; `.github/workflows/openclaw.yml` fails
  when tracked upstream files change.
- The first implemented capability is the read-only `rein_status` tool. It proves the plugin
  boundary and reports that automation is disabled. It is not business logic.
- Development plugin entries may point at TypeScript source because the runtime is a local source
  checkout. Publishing requires a built JavaScript entry, removing `private`, and verifying the
  packed install first.

All items below are unresolved. PRD suggestions remain suggestions.

| Decision | Needed before |
| --- | --- |
| Slack or Discord for P0; scopes and space mapping | Chat integration |
| Authoritative member registry and identity verification | Formal proposals |
| Zero-budget activity scope and exception authority | Automatic approval |
| Board roster, weight maintainer and conflict policy | Voting |
| Cadence, timezone, window, notification lead time | Voting |
| Quorum, approval, abstention, recusal, tie and re-vote rules | Voting |
| Competition/allocation rule, currency, available-funds source | Budget commitments |
| Payment, reimbursement and reconciliation owners | Funded activities |
| Material rights, retention/deletion and owner confirmation | Real evidence collection and publishing |
| Exception owners, deputies, appeal and emergency process | Pilot |
| Reminder cadence, quiet hours and snoozes | Proactive reminders |
| When and how often to bump the pinned OpenClaw commit; who reviews it | Regular runtime maintenance |
| Storage, hosting and website contracts | Technical implementation |
| License and public/private repository policy | Public release |

Record decisions with authority, date, policy version and effective date. Do not infer agreement from an absent response. Amend running governance only through the authorized exception process, never by silently changing its snapshot.
