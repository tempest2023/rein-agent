# Development and activation

1. Run `node scripts/check.mjs`. This validates scaffold assets and unresolved-policy defaults only.
2. Read the PRD and resolve the launch prerequisites in decisions.md with authorized owners.
3. Select and pin a tested OpenClaw release. Install using its official documentation; this repository intentionally does not run remote installation scripts.
4. Register a separate agent workspace using the documented CLI: `openclaw agents add rein --workspace /absolute/path/to/rein-agent/workspace`. Confirm flags against the selected release before use. Do not bind production channels yet.
5. Implement identity, policy, durable records, governance and outbox services with audited tool contracts. `config/operations.example.json` is a design input, not runtime enforcement.
6. Configure one selected chat platform, channel scopes and credentials outside git. Wire the website adapter with least-privilege service credentials. Keep private runtime memory outside the repository and enforce shared-session isolation.
7. Use synthetic data in a separate sandbox to verify AC01–AC20, including outage recovery, budget competition and consent withdrawal. Record the tested runtime version and results.
8. Have the designated operators explicitly activate approved policies and scoped tools for a limited pilot. Verify pause/recovery and exception ownership before widening access.

Workspace prompts alone do not establish access control. Until services and policies are ready, use the agent only for drafts and demonstrations with synthetic data.
