---
name: gitnexus-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\""
---

# Impact Analysis with GitNexus

## When to Use

- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing — to understand what your changes affect

## Workflow

```
1. list_repos() → Resolve the exact indexed repository
2. Record repository path, worktree status/HEAD, and full index commit
3. Stop graph-backed conclusions when the index commit differs from HEAD
4. Read `git status --short`; inspect tracked edits and every untracked file directly
5. impact({target: "X", direction: "upstream", repo: "<repo>"})
6. READ gitnexus://repo/{name}/processes → Check affected execution flows
7. detect_changes({scope: "all", repo: "<repo>", worktree: "<absolute path>"})
8. Assess risk and report to user
```

Record the repository, worktree, worktree HEAD, and index commit. Read the
repository context/status and compare the indexed commit with worktree HEAD
before graph calls. If they differ, stop graph-backed conclusions and label the
evidence stale. A matching commit does not cover tracked worktree edits: when
they exist, label graph evidence `commit-matched/content-unverified` and do not
draw definitive impact conclusions until the changed source is inspected.
Reindexing writes repository and registry state, so run
`node .gitnexus/run.cjs analyze` only with authority.

## Checklist

```
- [ ] Pin the exact repo, worktree, HEAD, and index commit
- [ ] Read `git status --short`; inspect tracked edits and untracked files before graph conclusions
- [ ] impact({target, direction: "upstream", repo}) to find dependents
- [ ] Review d=1 direct dependents first
- [ ] Check high-confidence (>0.8) dependencies
- [ ] READ processes to check affected execution flows
- [ ] detect_changes({scope: "all", repo, worktree}) for the intended checkout after the untracked-file check
- [ ] Treat partial, truncated, or UNKNOWN results as unresolved
- [ ] Warn and obtain acknowledgement before edits when runtime risk is HIGH or CRITICAL
- [ ] Assess risk level and report to user
```

## Understanding Output

| Depth | Meaning |
| --- | --- |
| d=1 | Direct callers/importers. Review first; dependency is not proof of breakage. |
| d=2 | Indirect dependents that may need review. |
| d=3 | Transitive dependents that may need focused tests. |

## Risk Assessment

The runtime score is a lower-bound graph heuristic, not a safety verdict:

| Runtime threshold | Risk |
| --- | --- |
| direct ≥30, processes ≥5, modules ≥5, or total ≥200 | CRITICAL |
| direct ≥15, processes ≥3, modules ≥3, or total ≥100 | HIGH |
| direct ≥5 or total ≥30 | MEDIUM |
| otherwise, when the walk completed | LOW |

`UNKNOWN` is not a low rung. Zero callers can mean unused code, but it can also
mean the index could not resolve dynamic dispatch, property access, or another
edge. Confirm with source/text search before treating the target as safe.

If `impact` returns `partial: true` or `pagination.truncated: true`, or if
`detect_changes` reports an incomplete result, the evidence is incomplete. A
short list or zero means unseen, not unaffected; re-run with a tighter target or
larger supported bound before using it as a gate. `detect_changes` is based on
Git diff and excludes untracked files, so inspect `git status --short` and those
files directly.

Warn the user and obtain acknowledgement before making edits when the runtime
risk is HIGH or CRITICAL. The label is still a review gate, not proof that a
specific caller will break.

## Tools

**impact** — the primary tool for symbol blast radius:

```
impact({
  target: "validateUser",
  direction: "upstream",
  repo: "my-app",
  minConfidence: 0.8,
  maxDepth: 3
})

→ d=1 (DIRECT REVIEW LEADS):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2 (INDIRECT REVIEW LEADS):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**detect_changes** — git-diff based impact analysis:

```
detect_changes({
  scope: "staged",
  repo: "my-app",
  worktree: "/absolute/path/to/my-app"
})

→ Changed: 5 symbols in 3 files
→ Affected: LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ Risk: MEDIUM
```

## Example: "What breaks if I change validateUser?"

```
1. impact({target: "validateUser", direction: "upstream", repo: "my-app"})
   → d=1: loginHandler, apiMiddleware (review their contracts)
   → d=2: authRouter, sessionManager (consider focused tests)

2. READ gitnexus://repo/my-app/processes
   → LoginFlow and TokenRefresh touch validateUser

3. Verify caller compatibility in source; report the runtime risk plus evidence
```
