---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

Commands below use `node .gitnexus/run.cjs <command>`—the project-local runner
created by `gitnexus analyze`. In the electric distribution, install the exact
versioned GitHub release tarball first and use the managed installed
`gitnexus`; do not bootstrap through an unqualified npm dist-tag.

If `run.cjs` is absent, confirm the selected repository and the installed
electric version, then run `gitnexus analyze` only with index-write authority.

## Commands

### analyze — Build or refresh the index

```bash
node .gitnexus/run.cjs analyze
```

Run from the exact project root. This parses source, writes `.gitnexus/`,
updates the global registry, writes `.gitnexus/run.cjs`, and may create/update
CLAUDE.md, AGENTS.md, and project skills. Use `--index-only` when the approved
action is limited to the index. Do not run against the wrong worktree.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |
| `--pdg` | Build the program-dependence layers used by `explain` and `pdg_query` (taint, CDG, and REACHING_DEF). |

Embedding generation may call a configured remote provider. Relevant settings
are `GITNEXUS_EMBEDDING_URL`, `GITNEXUS_EMBEDDING_MODEL`,
`GITNEXUS_EMBEDDING_API_KEY`, and `GITNEXUS_EMBEDDING_DIMS`; flags also cover
device, threads, and batch size. Never paste keys into commands, logs, issues,
or committed files.

**When to run:** First index or a deliberately authorized refresh. A hook may
report staleness after Git operations, but it does not authorize or run analyze.
Avoid overlapping writers; LadybugDB expects one writer.

### status — Check index freshness

```bash
node .gitnexus/run.cjs status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
node .gitnexus/run.cjs clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global
registry. Confirm the exact repository before running it. `--force` skips the
prompt, and `--all` affects every registered repository; neither is a routine
reindex prerequisite.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
node .gitnexus/run.cjs wiki
```

Generates repository documentation using an LLM. This can send repository
content to the configured provider and save provider configuration under
`~/.gitnexus/`. Confirm the provider/account and data policy first. Avoid
`--api-key` in shell history; use the supported secure environment/config path.

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

`--gist` is a public, account-visible write. Verify the active GitHub account
and obtain publication authority before using it.

### list — Show all indexed repos

```bash
node .gitnexus/run.cjs list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` or configure the exact
  `GITNEXUS_EMBEDDING_*` provider settings; `OPENAI_API_KEY` is for wiki LLM
  usage, not the embedding contract
