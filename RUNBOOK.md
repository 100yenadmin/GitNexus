# Runbook — GitNexus

Short, copy-paste operations for **local development**, **MCP**, and **CI**. Commands assume a Unix shell; on Windows use Git Bash or equivalent paths.

## Prerequisites

- **Node.js** ≥ 20 (`gitnexus-web/package.json` `engines`).  
- **Git** (analyze requires a git repository).  
- From repo root, install and build the CLI package:

```bash
cd gitnexus
npm install
npm run build
```

Use `npx gitnexus …` from any path after global/published install, or `node dist/cli/index.js …` when developing from `gitnexus/` with a local build.

---

## Index out of date / “stale” tools

**Symptom:** MCP or resources warn the index is behind `HEAD`, or results don’t reflect recent commits.

**Fix (from the target repo root):**

```bash
npx gitnexus analyze
```

**Force full rebuild** (same commit but suspect corruption or changed ignore rules):

```bash
npx gitnexus analyze --force
```

**Check status:**

```bash
npx gitnexus status
```

**List what MCP knows about:**

```bash
npx gitnexus list
```

---

## Embeddings

**First time with vectors** (slower, more disk/RAM):

```bash
npx gitnexus analyze --embeddings
```

**Important:** A plain `analyze` preserves existing embeddings. Pass `--embeddings <n>` when
you also want changed or new owners regenerated under a positive node cap; use
`--drop-embeddings` only when intentionally replacing the existing vectors. See
`stats.embeddings` in `.gitnexus/gitnexus.json` (or its legacy `meta.json` mirror; 0 means
none).

**Large repos:** Analyze may skip or limit embedding work when node counts are very high; watch CLI output.

---

## MCP: no repos / empty tools

**Symptom:** `GitNexus: No indexed repos yet` on stderr when starting MCP.

**Fix:** In each project you want indexed:

```bash
cd /path/to/repo
npx gitnexus analyze
```

Restart the editor MCP session if needed. The server **refreshes the registry lazily**; new analyzes are picked up without necessarily reinstalling MCP.

**Symptom:** Wrong repo when multiple are indexed — pass `repo` on tools or use `list_repos` first.

---

## Clean slate (corrupt or huge `.gitnexus`)

**Current repo only** (prompts for confirmation):

```bash
npx gitnexus clean
```

**Skip confirmation:**

```bash
npx gitnexus clean --force
```

**All registered repos:**

```bash
npx gitnexus clean --all --force
```

Then re-run `npx gitnexus analyze` (and `--embeddings` if you need vectors).

---

## Local bridge for the web UI

```bash
cd gitnexus
npx gitnexus serve
# default http://127.0.0.1:4747 — see serve --help for port/host
```

Use when the browser UI should talk to **local** indexed repos instead of WASM-only mode.

---

## CLI equivalents of MCP tools

Useful for debugging without an editor:

```bash
cd gitnexus
npx gitnexus query "authentication flow" --repo MyRepo
npx gitnexus context SomeSymbol --repo MyRepo
npx gitnexus impact SomeSymbol --direction upstream --repo MyRepo
npx gitnexus cypher "MATCH (n) RETURN count(n) LIMIT 1" --repo MyRepo
```

---

## CI failures (contributors)

Orchestrator: `.github/workflows/ci.yml`.

| Job | Typical local repro |
|-----|---------------------|
| **quality** | `cd gitnexus && npx tsc --noEmit` |
| **unit-tests** | `cd gitnexus && npx vitest run test/unit` |
| **integration** | `cd gitnexus && npx vitest run test/integration` (see workflow matrix for groups) |
| **e2e** | Triggered when `gitnexus-web/` changes; `cd gitnexus-web && E2E=1 npx playwright test` (requires `gitnexus serve` + `npm run dev`) |

**Note:** Pushes that touch only certain markdown paths may be skipped by `paths-ignore` in CI — see workflow file for exact patterns.

---

## Memory / analyze crashes

Analyze re-execs Node with a **large old-space heap** when needed (`analyze.ts`). If you still OOM on huge repos, close other processes, avoid `--embeddings` for a first pass, or analyze a smaller path if supported by your workflow.

---

## LadybugDB / lock errors

Only one process should open a repo's `.gitnexus/lbug` store at a time. If MCP and a second `analyze` run conflict, stop one process, then retry `analyze` or restart MCP.

If the error text is `"Only one write transaction at a time is allowed in the system."` instead of a lock/busy message, it's the same underlying conflict — our retry matcher (`isDbBusyError` in `src/core/lbug/lbug-config.ts`) recognizes this exact string and auto-retries it. The fix if it still surfaces after retries is the same: stop the overlapping process.

---

## Where to dig deeper

- Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md)  
- Agent safety rules: [GUARDRAILS.md](GUARDRAILS.md)  
- Tests: [TESTING.md](TESTING.md)

## Bounded embedding preservation and staged recovery

For a healthy index that is stale against its source, run incremental analysis with a positive
embedding cap:

```bash
npx gitnexus analyze --embeddings <n>
```

The incremental path rewrites the changed/effective file set, regenerates changed or new
embedding owners within the cap, and retains unaffected logical embedding-row payloads. If the
effective write set is large, the existing escalation valve may select a full write while
retaining the same bounded snapshot and restore contract.

For malformed or provenance-unproven embedding state, use an explicit staged clean rebuild:

```bash
npx gitnexus analyze --staged --embeddings <n> --drop-embeddings
```

The staged generation is disposable and the canonical generation remains readable until
validation and journaled promotion complete. Keep the canonical logical embedding-row and
metadata preimage available for rollback. The deterministic proof covers logical row payloads,
not raw LadybugDB container bytes; legacy rows without durable provider or identity proof remain
unproven and are not called verified preservation.

---

## Electric fork releases

Electric Sheep fork releases are GitHub Releases only. The fork does not publish
to npm, GitHub Container Registry, Docker Hub, or another package registry.

Prepare each version through a reviewed release PR:

1. Set `gitnexus/package.json` and `gitnexus/package-lock.json` to the reviewed
   fork version, such as `1.6.10-electric.11`.
2. Run `node gitnexus/scripts/sync-plugin-versions.mjs` from the repository root.
3. Add `Documentation/releases/<version>.md` and update `gitnexus/CHANGELOG.md`.
4. Run `npm run check:electric-release-policy`, the plugin-version test, build,
   typecheck, and `npm pack --dry-run`.
5. Merge the release PR only after required CI and review pass.

Create the release from the current `main` branch with the protected workflow:

```bash
gh workflow run electric-release.yml \
  --repo electricsheephq/evaOS-gitnexus \
  --ref main \
  -f expected_version=1.6.10-electric.11 \
  -f prerelease=false
```

The workflow reruns exact-head CI, builds `gitnexus-<version>.tgz`, installs and
smokes that tarball in an isolated prefix, writes `SHA256SUMS`, and pauses at the
protected `internal-release` environment before creating
`electric/v<version>`. It never opens a GitNexus index or calls an embedding
provider. The release is staged as a draft: a failed asset upload leaves an
exact-head tag and resumable draft, and redispatch safely resumes them. A
published release or a same-name tag pointing elsewhere fails closed; never
delete or rewrite a published tag to retry.

`check-electric-release-policy.mjs` is defense in depth, not a shell-language
interpreter. It rejects direct npm/Docker publication, registry-write
permissions, registry configuration and credential variables, dynamic registry
push inputs, and new unapproved OIDC jobs. Required review, branch protection,
the protected environment, and the absence of registry credentials remain part
of the release boundary. Registry-adjacent workflow strings have no silent
allowlist escape; an intentional policy change requires a reviewed checker and
negative-test change.

The package proof intentionally installs and executes the tarball on an isolated
GitHub-hosted runner. Only protected-main manifests are read first; they must be
regular JSON files no larger than 64 KiB and must match the committed package
version. This proves the native CLI artifact without granting registry, runtime,
index, or embedding access.

After downloading both assets, verify and install locally:

```bash
shasum -a 256 --check SHA256SUMS
npm install --global ./gitnexus-1.6.10-electric.11.tgz
gitnexus --version
```

A GitHub Release does not authorize an OpenClaw/evaOS rollout. Keep the prior
`1.6.10-electric.10` installation available as non-writing rollback bytes, switch
runtime source separately, and do not rebuild or migrate a live index unless that
rollout explicitly requires it.
