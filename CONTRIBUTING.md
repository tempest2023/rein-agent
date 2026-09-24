# Contributing

Associate changes with PRD R, US or AC identifiers. Separate confirmed requirements, design suggestions and implemented behavior. For behavioral changes include a concrete trigger, expected result and meaningful test evidence.

Do not commit secrets or real organization records. Run `node scripts/check.mjs` for documentation/template changes. Business-logic work must add appropriate authorization, concurrency, deadline, idempotency and recovery tests. Choose runtime dependencies only after recording the integration decision.

Use synthetic examples explicitly marked as fixtures. Keep Chinese and English requirements aligned. A change to an example config does not constitute governance approval.

Develop Rein capabilities in `plugins/`, using public OpenClaw SDK seams. Do not modify tracked files in `vendor/openclaw`. For plugin/runtime changes follow `docs/setup.md`, run `pnpm test` and runtime plugin inspection, and review the separate upstream update procedure in `docs/upstream.md`.
