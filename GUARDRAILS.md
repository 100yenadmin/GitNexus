# Guardrails — GitNexus

Rules for **human contributors** and **AI agents**. Complements `AGENTS.md` (workflows) and `CONTRIBUTING.md` (PR process).

## Scope (least privilege)

- **Read:** Source, tests, docs, public config as needed.
- **Write:** Only files required for the fix or feature; no unrelated formatting or refactors.
- **Execute:** Tests, typecheck, documented CLI commands. No destructive commands on user data without approval.
- **Off-limits:** Other people's machines, production deployments you don't own, credentials you lack permission to use.

Maintainer may widen scope per task.

---

## Non-negotiables

1. **Never commit secrets** — API keys, tokens, real `.env` values, private URLs, session cookies. Use `.env.example` with placeholders.
2. **Never rename with find-and-replace** in GitNexus-indexed projects — use `rename` MCP tool with `dry_run: true` first, review `graph` vs `text_search` edits. No separate `gitnexus rename` CLI exists.
3. **Run impact analysis before editing shared symbols** — `impact` (upstream) for functions/classes/methods others call. Do not ignore HIGH/CRITICAL without maintainer sign-off.
4. **Run `detect_changes` before commit** — confirm diffs map to expected symbols/processes when the graph is available.
5. **Preserve embeddings** — plain `npx gitnexus analyze` now preserves any embeddings recorded in the index metadata (`.gitnexus/gitnexus.json`, mirrored to the legacy `meta.json`) — the previous behavior wiped them. Use `--embeddings` to also generate vectors for new/changed nodes; use `--drop-embeddings` only when an explicit wipe is intended (e.g., model swap).
6. **Use the bounded recovery contract** — for healthy indexes that are stale against source, use a positive embedding cap (`--embeddings <n>`) so the incremental path retains unaffected logical embedding-row payloads and regenerates only changed/new owners. For malformed or provenance-unproven state, use an explicit positive-cap staged clean rebuild (`--staged --embeddings <n> --drop-embeddings`) and keep the canonical generation as the rollback preimage until validated promotion completes. Older rows without durable provider or identity proof remain unproven; never call them verified preservation.

---

## Signs (recurring failure patterns)

Format: **Trigger → Instruction → Reason**. Append new Signs when the same mistake repeats.

### Stale graph after edits

- **Trigger:** MCP warns index is behind `HEAD`, or search doesn't match latest commit.
- **Do:** `npx gitnexus analyze` (plus `--embeddings` if used). Runs incrementally by default — the pipeline parses every file every run (cross-file resolution requires it), but tree-sitter dispatch is skipped for unchanged file chunks via the content-addressed cache, and only changed-file rows (plus their importers, transitively) are rewritten in LadybugDB. When the effective write set exceeds ~50% of the repo's files (minimum 50 files), the run transparently switches to the full wipe + bulk-COPY write plan and logs "switching to a full DB write" — expected behavior, not a bug, and file-level bookkeeping stays incremental.
- **Why:** Tools query LadybugDB from last analyze; git changes are invisible until re-indexed.

### Index seems corrupt or "incremental" is misbehaving

- **Trigger:** `analyze` produces unexpected results, or `incrementalInProgress` is set in the index metadata (`.gitnexus/gitnexus.json` / legacy `meta.json`), or the index is in a half-state after a crash.
- **Do:** `npx gitnexus analyze --force` to rebuild from scratch. The dirty-flag check forces this automatically when a previous incremental run didn't complete cleanly, but `--force` is the manual escape hatch. A dirty-flag recovery rebuild parks the interrupted run's sidecars beside the DB as `lbug.wal.dirty-recovery` / `lbug.shadow.dirty-recovery` for post-mortem debugging — harmless, and removable with `npx gitnexus clean --lbug-sidecars`. Safe to delete the `.gitnexus/parse-cache/` directory (and any legacy `.gitnexus/parse-cache.json`) at any time — content-addressed, will be regenerated.
- **Why:** Incremental writeback is selective DB row replacement; if the on-disk state is inconsistent for any reason, a full rebuild is the cheapest path back to a known-good index.

### Embeddings vanished after analyze

- **Trigger:** Semantic search quality drops; `stats.embeddings` in the index metadata (`gitnexus.json` / legacy `meta.json`) is 0 after refresh.
- **Do:** Re-run `npx gitnexus analyze --embeddings` to regenerate. Check the analyze log for a `Warning: could not load cached embeddings` line — if present, the cache restore failed (corrupt DB / schema mismatch) and the rebuild had nothing to preserve. If you intentionally passed `--drop-embeddings`, this is expected.
- **Why:** Plain `analyze` preserves prior vectors by re-inserting them after the rebuild; the only ways to end up at zero are an explicit `--drop-embeddings`, a cache-load failure (now logged), or a model/dimension change that invalidates the cache. A dirty-recovery run that cannot move the crashed WAL aside now either discards it (logged: forensics lost, embeddings still preserved) or fails fast with a lock error naming the holder — it never silently zeroes embeddings.

### Embedding state is malformed or provenance is unproven

- **Trigger:** Doctor or read-only integrity inspection reports malformed, duplicate, orphaned, wrong-dimension, or otherwise unproven embedding state, including legacy rows without durable provider or identity proof.
- **Do:** Preserve the canonical logical embedding-row and metadata preimage, then run an explicit positive-cap staged clean rebuild: `npx gitnexus analyze --staged --embeddings <n> --drop-embeddings`. Validate the isolated generation before journaled promotion; on a promotion failure, use the staged rollback path and verify that the logical preimage is restored with no stage, backup, or journal residue.
- **Why:** A staged clean rebuild gives malformed or unclassified derived state a bounded replacement path without treating old rows as verified. The deterministic proof covers logical row payloads, not raw LadybugDB container bytes.

### MCP lists no repos

- **Trigger:** MCP stderr says no indexed repos.
- **Do:** `npx gitnexus analyze` in the target repo; verify `npx gitnexus list` shows it.
- **Why:** MCP discovers repos via `~/.gitnexus/registry.json`, populated by analyze.

### Wrong repo in multi-repo setups

- **Trigger:** Query/impact results belong to another project.
- **Do:** Call `list_repos`, then pass `repo` on subsequent tools.
- **Why:** Default target is ambiguous when multiple repos are registered.

### MCP repository policy is degraded or blocked

- **Trigger:** MCP tool descriptions or `list_repos` report a degraded repository policy, or calls report `MCP repository policy is blocked`.
- **Do:** Run `gitnexus doctor --mcp-config --json` and repair the named environment key/entry. For an ambiguous allowlist entry, replace the bare repository name with its unique absolute indexed path. Restart the MCP client after changing its environment. Do not remove the allowlist or choose a worktree arbitrarily.
- **Why:** Each rejected allowlist entry grants no access. Other successfully resolved entries remain available and agent-visible diagnostics identify the rejected positions without exposing configured values. Stdio and HTTP remain fully blocked when a configured allowlist resolves no repositories, or when the configured default is invalid or outside the successfully resolved allowlist.

### LadybugDB lock / "database busy"

- **Trigger:** Errors opening `.gitnexus/lbug` while MCP and analyze both run.
- **Do:** Stop overlapping processes (one writer at a time). Retry analyze or restart MCP.
- **Why:** Embedded DB expects single-process ownership. `@ladybugdb/core` 0.18.0 also reports this contention as `"Only one write transaction at a time is allowed in the system."` — our busy/lock retry matcher (`isDbBusyError` in `src/core/lbug/lbug-config.ts`) recognizes this exact string too, so it's auto-retried the same as any other lock error. If you see that exact message, it's the same "one writer at a time" issue above, not a new failure mode.

---

## Publishing & supply chain

- **npm:** Do not publish from unreviewed automation. Bump version intentionally; tag releases to match `package.json`.
- **Electric releases:** Distribution is GitHub Release assets only. Do not publish an Electric version to npm, a container registry, or another package registry, and do not use a floating tag. Keep `1.6.10-electric.10` available as the immediate non-writing rollback artifact while `.11` release/install/runtime work is proved separately.
- **Dependencies:** Minimal, auditable `package.json` changes; run tests and CI after lockfile updates.
- **License:** PolyForm Noncommercial 1.0.0 — do not relicense without maintainer approval.

---

## Escalation

Stop and ask a **human maintainer** when:

- Impact analysis shows HIGH/CRITICAL risk and the task still requires the change.
- You need to alter CI, release, or security-sensitive config.
- Requirements conflict (e.g. "speed up analyze" vs "must keep all embeddings on huge repo").
- You are unsure whether data loss is acceptable (`clean`, forced migrations, schema changes).

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [RUNBOOK.md](RUNBOOK.md) — commands for recovery
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR and commit expectations
