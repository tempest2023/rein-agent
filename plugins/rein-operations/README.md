# Rein Operations — local OpenClaw plugin

The native plugin is separate from `vendor/openclaw` and imports only the public `openclaw/plugin-sdk/plugin-entry` seam. Its first implemented tool, `rein_status`, reports the development state without external effects. Membership, proposals, voting, budgets and publishing remain planned.

Manifest: `openclaw.plugin.json`. Runtime entry: `index.ts`. Artwork: `assets/icon.png` (approved Bot Icon). The source TypeScript entry is for local development; before publishing, build JavaScript, change the entry to `dist/index.js`, remove `private`, and verify the packed install. Do not publish the development package as-is.

The local `openclaw` development link uses this repository's pinned host; the peer dependency deliberately does not promise compatibility with untested future versions. Update it after compatibility verification. Plugin APIs are experimental.

New business tools belong here or in additional Rein-owned packages, never in upstream `src/` or `extensions/`. Use deterministic authorization and durable records, optional tools for side effects, and names prefixed `rein_`. A prompt or manifest declaration is not an authorization check.

See [setup](../../docs/setup.md) and [updating OpenClaw](../../docs/upstream.md).
