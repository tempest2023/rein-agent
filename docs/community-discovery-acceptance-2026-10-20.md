# Community discovery acceptance — 2026-10-20

The Foundation backend and Nori tools were tested together against the real database and Discord.
This was a scoped development acceptance run, not a production deployment.

## Automated checks

- Agent: 1,073 tests passed, two skipped; repository check and native OpenClaw plugin loading passed.
- Website: 321 tests across 31 files passed; TypeScript, oxlint and `next build --webpack` passed.
- The onboarding skill passed its structural validator.
- Tests cover ordinary linked Discord/Slack members, missing/expired/revoked links, revocation or
  rebinding during a query, caller/channel/proof restrictions, input spoofing, public field projection,
  publication filtering, pagination, event windows and explicit backend failure.

## Real catalog verification

The development resource table was empty. A temporary snapshot copied only the public fields of
the 16 published production resources into DEV, retaining their record IDs and source timestamps.
Private approval metadata was not copied. Production records were never modified.

The actual tools called the local Website backend over HTTP with freshly minted ingress assertions.
All 16 returned resource records matched the production source across the exposed public fields.
Pagination, resource detail, English course filtering and a literal query containing filter syntax
were also checked. Both real activity catalogs were empty: event search returned `empty` and a
missing event detail returned `not_found`. Positive event/session cases used synthetic automated
fixtures; this run does not claim to have found a real upcoming activity.

## Real Discord conversation

A separate temporary OpenClaw gateway used Nori's bot in the existing QA channel, restricted to two
QA bots. It loaded the new skill and tools and used the real Foundation authorization chain.
The resident Nori gateway and its configuration were left running unchanged.

| Case | Observed backend result | Observed Nori behavior |
| --- | --- | --- |
| Linked QA member asks for English beginner Agent courses | Resource search 200, `found` | Recommends the catalog's Hugging Face and Microsoft courses with correct URLs and access notes; labels the development source |
| Linked member asks for upcoming in-person/hybrid activities | Two event searches 200, `empty` | Reports no matches in the queried development catalog, without inventing a date or registration entry |
| Unlinked QA account requests courses | 403, `binding_not_verified` | Explicitly reports lookup failure and offers the existing account-link flow; does not reuse another member's results |
| The first member's link is revoked, then the same conversation requests another lookup | 403, `identity_revoked` | Calls the tool again, reports failure, and does not reuse its own earlier successful results |

The positive QA identity used a temporary verified DEV link. This validates the membership gate;
it is not an end-to-end email verification test. The negative cases opened temporary link sessions
but sent no email. Their localhost verification URLs were development configuration, not public
member onboarding links. Slack authorization was covered by automated tests, not a live Slack run.

## Cleanup and rollout

All ten test messages were removed by their exact IDs. The temporary resource snapshot, contact,
platform link, service caller, link sessions and ingress assertions were removed, with zero remaining
fixture rows verified. The QA gateway and local Website server were stopped; private diagnostics
remain in ignored local storage and are not part of this change.

Rollout requires the Website backend first, an explicitly assigned `community.read` caller scope,
then the Agent plugin, tool allowlist and skill in the actual runtime workspace. No production
deployment or permanent caller-scope change was performed during this acceptance run.
