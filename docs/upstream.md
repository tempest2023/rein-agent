# Updating OpenClaw

Rein Agent does not fork OpenClaw. The official source is vendored as a git submodule at
`vendor/openclaw`, pinned to one reviewed commit. Rein behaviour lives in `plugins/`, so upgrading consists of reviewing the new pin, rebuilding the runtime, and checking plugin compatibility.

Read the pin from the repository instead of trusting a number in a document:

```sh
git -C vendor/openclaw rev-parse HEAD          # commit currently checked out
git ls-files -s vendor/openclaw                # pointer recorded by the index
git ls-tree HEAD vendor/openclaw               # pointer recorded by the last commit
node -p "require('./vendor/openclaw/package.json').version"
```

Upstream requires Node `>=24.16.0 <25` or `>=26.1.0`, and pins its own pnpm `12.4.2`.

## Ground rules

- Treat `vendor/openclaw` as read-only. Do not edit tracked files there, and never commit Rein
  code into it.
- Keep the pin on a detached commit. A submodule pointer records a commit; a branch name would
  move under you.
- Runtime config and state live under `runtime/` (gitignored). An update never touches them, and
  never touches `workspace/` or `plugins/`.
- Do not claim an update works until the rebuilt CLI loads `rein-operations` and answers
  `rein_status`.

## Reviewed update

From the repository root:

```sh
git -C vendor/openclaw rev-parse HEAD              # note the current pin
pnpm upstream:update <branch|tag|commit>    # default is main
```

What the script does, in order:

1. Rejects a ref that is not a plain branch, tag or commit name.
2. Refuses to continue when `vendor/openclaw` has local changes.
3. Runs `git fetch --depth=1 origin <ref>` and `git checkout --detach FETCH_HEAD`.
4. Prints the previous and candidate commit. It restarts no service and edits no Rein file.

If the fetch fails, the checkout stays on the previous commit. When the script finishes you are on
a detached candidate that is not yet trusted or committed. Do not run `git submodule update` before accepting/staging that candidate; it intentionally restores the recorded old pin. The previous commit remains available locally for the printed rollback and two-tree diff; fetching deeper history is needed for ancestry/bisect.

Check the candidate package's `engines` and `packageManager` before installing. If its OpenClaw version changes, update the plugin peer/build metadata in the working tree for the candidate, then retain those changes only after compatibility checks pass. Do not widen compatibility speculatively.

## Review the candidate

```sh
git -C vendor/openclaw log --oneline -1
git -C vendor/openclaw diff --stat <previous-sha> HEAD
pnpm --dir vendor/openclaw install --frozen-lockfile
pnpm --dir vendor/openclaw build
pnpm run check
pnpm test
pnpm openclaw plugins doctor
pnpm openclaw plugins inspect rein-operations --runtime --json
pnpm verify:plugin
```

Then start a local gateway and exercise the tool with synthetic data:

```sh
pnpm openclaw gateway run
pnpm openclaw gateway health --port 18791   # from a second terminal
pnpm smoke:gateway
```

Accept the update only when the plugin loads, `rein_status` answers, and the checks pass on the
candidate. Read upstream `CHANGELOG.md` for breaking changes before deciding.

## Compatibility fields

`plugins/rein-operations/package.json` states the window the plugin was built against:
`peerDependencies.openclaw`, `openclaw.compat.pluginApi` and `openclaw.compat.minGatewayVersion`.

Widen those only after a candidate passes the review above, and change them in the same commit as
the new pin so reviewers can see both together. The plugin imports only the public
`openclaw/plugin-sdk/plugin-entry` entry point; plugin APIs are still experimental upstream.

## Commit the new pin

```sh
git add vendor/openclaw
git commit -m "Update vendored OpenClaw to <version-or-sha>"
```

The commit records the submodule pointer. Reviewers then read the pointer change plus the
plugin-side compatibility edits, without diffing upstream source.

## Rollback

The script prints the exact rollback command, for example:

```sh
git -C vendor/openclaw checkout --detach <previous-sha>
```

To return to the commit the repository records instead:

```sh
git submodule update --checkout vendor/openclaw
```

After either form, rebuild `vendor/openclaw` before running the CLI again. Local config in
`runtime/openclaw/openclaw.json` and its generated token are preserved; nothing needs
regenerating.

## Shallow fetch caveat

Updates fetch with `--depth=1` to stay fast. If you need upstream history to read a diff or bisect:

```sh
git -C vendor/openclaw fetch --unshallow
git -C vendor/openclaw fetch --tags
```

Both require network access and are optional.

## If the plugin fails on a candidate

The plugin is the likely breakage point, not the runtime. Reproduce with
`pnpm openclaw plugins doctor`, adjust `plugins/rein-operations` to the new public SDK
surface, and re-run `pnpm test`. If the candidate cannot be made to work, roll the pin back, keep
Rein on the known-good commit, and report the incompatibility instead of editing upstream source.

## Automated coverage

`.github/workflows/openclaw.yml` runs on changes to `vendor/openclaw`, `.gitmodules`, `plugins/**`,
`scripts/**`, `tests/**` and the workspace manifests. It installs and builds upstream on Node
`24.16.0`, runs `pnpm check` and `pnpm test`, creates the isolated local config, inspects the plugin
with `--runtime`, and fails if `git -C vendor/openclaw status --porcelain` is non-empty. That last
step enforces the read-only rule above.

See [setup](setup.md) for the full local bootstrap and [architecture](architecture.md) for why the
boundary sits here.
