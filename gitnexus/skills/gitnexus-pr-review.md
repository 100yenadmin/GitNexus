---
name: gitnexus-pr-review
description: "Use when the user wants to review a pull request, understand what a PR changes, assess risk of merging, or check for missing test coverage. Examples: \"Review this PR\", \"What does PR #42 change?\", \"Is this PR safe to merge?\""
---

# PR Review with GitNexus

Review the requested change without editing source, switching or resetting the
user's checkout, committing, pushing, posting, or resolving threads. GitNexus
provides structural evidence; source inspection and focused tests establish
whether a concrete defect exists.

## Resolve and pin the target

For a GitHub PR, use `gh pr view` or `gh api` to record:

- repository owner/name and local repository root;
- PR number and URL;
- base ref and exact base SHA;
- head ref and exact head SHA;
- merge base from `git merge-base <base-sha> <head-sha>`;
- exact worktree used for the review.

Fetch the exact base and head commits without switching the user's branch.
Fork PRs may require the pull ref or contributor remote; do not assume the head
branch exists on `origin`. Use `git diff <merge-base> <head-sha>` as the PR diff
source of truth.

Reuse a worktree only when it is at the exact head SHA. Otherwise use an
independent detached worktree only when the user has authorized creating and
removing one. If an exact checkout is unavailable, stop the graph-backed lane
and state the limitation.

## Bind the graph to the same source

Read GitNexus status for the target repository and record the indexed commit.
The repository, worktree head, diff head, and graph index commit must identify
the same source before the review is described as graph-backed. Do not run
`analyze`, reindex, clean, or mutate the registry unless the user authorized
that side effect.

Commit equality is necessary but not sufficient: analysis reads live tracked
and untracked content while the stored index identity records only `HEAD`. Treat
the graph as exact only when analysis-time clean-worktree/content provenance is
available. Otherwise report it as commit-matched but content-unverified, and
verify claims in the pinned source instead of presenting the graph as exact.

When the exact graph already exists, pass identity explicitly:

```text
detect_changes({
  scope: "compare",
  base_ref: "<merge-base-sha>",
  repo: "<exact-indexed-repository>",
  worktree: "<absolute-head-worktree>"
})
```

Use the same explicit `repo` for `impact`, `context`, and resource reads.
If the graph index commit does not match the head SHA, review the raw source and
diff, label graph evidence stale or skipped, and do not blend it into the
verdict as if it described the PR.

## Review workflow

1. Read the complete local diff and changed-file list at the pinned SHAs.
2. Run `detect_changes` against the exact merge base, repository, and worktree.
3. If the result has `partial: true` or `truncated: true`, treat it as incomplete.
   A short or empty result is not proof that the change has no dependents.
4. Run `impact({target, direction: "upstream", includeTests: true, repo})` for
   behaviorally changed symbols.
5. Inspect each direct dependent outside the diff. A direct dependency is a
   review lead, not proof that it breaks; verify the contract and caller source.
   For a fully deleted symbol or file, the head graph cannot resolve the removed
   node. Inspect the merge-base source and use bounded source/text search for
   callers; label deletion impact incomplete rather than reporting low risk.
6. Use `context({name, repo})` and exact process resources for key symbols.
7. Read new files, generated files, configuration, and untracked content
   directly because graph and Git diff coverage may be incomplete.
8. Run the narrowest focused tests that exercise the claimed behavior.
9. Reconcile source, graph, and test evidence before assigning severity.

## Finding standard

Report a finding only when the change introduces a concrete defect, regression,
security issue, compatibility break, or material missing test. Each finding
must include:

- severity and a precise `path:line` anchor;
- a reachable failing scenario or violated contract;
- source or test evidence;
- GitNexus dependent/process evidence when applicable;
- a concise remediation.

Do not report style preferences, pre-existing problems, raw risk counts, or
speculation as defects. Do not infer safety from zero graph hits.

## Output

```markdown
## PR Review: <title or target>

### Provenance

- Repository: <owner/name and absolute local root>
- Base SHA: <sha>
- Head SHA: <sha>
- Merge base: <sha>
- Worktree: <absolute path>
- GitNexus index commit: <sha or unavailable>
- Graph status: exact | commit-matched/content-unverified | stale | skipped
- Local states included: committed | staged | unstaged | untracked

### Findings

- [HIGH|MEDIUM|LOW] `path:line` — <problem, proof, impact, remediation>

### Change and blast-radius summary

- Changed symbols/files and affected execution flows
- Direct dependents reviewed in source

### Coverage and residual risk

- Focused checks run
- Missing or incomplete graph, diff, untracked, and test evidence

### Recommendation

APPROVE | REQUEST CHANGES | NEEDS DISCUSSION
```

Always include the exact identities so a later review can detect stale evidence.
