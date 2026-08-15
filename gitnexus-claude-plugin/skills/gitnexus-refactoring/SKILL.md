---
name: gitnexus-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\""
---

# Refactoring with GitNexus

## When to Use

- "Rename this function safely"
- "Extract this into a module"
- "Split this service"
- "Move this to a new file"
- Any task involving renaming, extracting, splitting, or restructuring code

## Workflow

```
1. Pin repo, absolute worktree, worktree HEAD, and index commit
2. impact({target: "X", direction: "upstream", repo: "<repo>"})
3. query({search_query: "X", repo: "<repo>"})
4. context({name: "X", repo: "<repo>"})
5. Plan update order: interfaces → implementations → callers → tests
```

If the index is stale, do not present it as current. Reindexing writes repository
and registry state; run it only with authority.

## Checklists

### Rename Symbol

```
- [ ] rename({symbol_name: "oldName", new_name: "newName", dry_run: true, repo}) — preview edits
- [ ] Review graph edits (high confidence) and text_search edits (review carefully)
- [ ] If satisfied: rename({..., dry_run: false, repo}) — apply edits
- [ ] Read Git status/diff and every affected untracked file directly
- [ ] detect_changes({scope: "all", repo, worktree}) — graph-map the Git diff
- [ ] Run tests for affected processes
```

Preview and apply are separate recomputations, not an immutable transaction.
There is no plan token or content hash binding apply to the preview. Recheck the
worktree immediately before apply and re-preview after any intervening change.
The current implementation may replace whole-file word matches, including in
untracked files; Git-diff-based `detect_changes` cannot prove those untracked
edits. Treat source/diff inspection and focused tests as the verification gate.

If `rename` or `detect_changes` reports `partial: true` or `truncated: true`,
the result is short of the truth. An empty or short list is not proof that only
the expected files changed; re-run or inspect directly before treating the
refactor as verified.

### Extract Module

```
- [ ] context({name: target, repo}) — see all incoming/outgoing refs
- [ ] impact({target, direction: "upstream", repo}) — find all external callers
- [ ] Define new module interface
- [ ] Extract code, update imports
- [ ] detect_changes({scope: "all", repo, worktree}) — map affected scope
- [ ] Run tests for affected processes
```

### Split Function/Service

```
- [ ] context({name: target, repo}) — understand all callees
- [ ] Group callees by responsibility
- [ ] impact({target, direction: "upstream", repo}) — map callers to update
- [ ] Create new functions/services
- [ ] Update callers
- [ ] detect_changes({scope: "all", repo, worktree}) — map affected scope
- [ ] Run tests for affected processes
```

## Tools

**rename** — automated multi-file rename:

```
rename({
  symbol_name: "validateUser",
  new_name: "authenticateUser",
  dry_run: true,
  repo: "my-app"
})
→ 12 edits across 8 files
→ 10 graph edits (high confidence), 2 text_search edits (review)
→ Changes: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**impact** — map all dependents first:

```
impact({target: "validateUser", direction: "upstream", repo: "my-app"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

**detect_changes** — verify your changes after refactoring:

```
detect_changes({scope: "all", repo: "my-app", worktree: "/absolute/path/to/my-app"})
→ Changed: 8 files, 12 symbols
→ Affected processes: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

**cypher** — custom reference queries:

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath ORDER BY caller.filePath
LIMIT 100
```

## Risk Rules

| Risk Factor         | Mitigation                                |
| ------------------- | ----------------------------------------- |
| Many callers (>5)   | Use rename for automated updates |
| Cross-area refs     | Use detect_changes after to verify scope  |
| String/dynamic refs | query to find them               |
| External/public API | Version and deprecate properly            |

## Example: Rename `validateUser` to `authenticateUser`

```
1. rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true, repo: "my-app"})
   → 12 edits: 10 graph (safe), 2 text_search (review)
   → Files: validator.ts, login.ts, middleware.ts, config.json...

2. Review text_search edits (config.json: dynamic reference!)

3. Confirm the worktree is unchanged since preview, then apply with the same repo.
   → Applied 12 edits across 8 files

4. Inspect Git status/diff/untracked files, then run detect_changes with repo/worktree.
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — run tests for these flows
```
