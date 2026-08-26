/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import { resetDegradedParseCounter } from './tree-sitter/safe-parse.js';
import {
  initLbug,
  initLbugForMaintenance,
  initLbugReadOnlyNonRecovering,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  withLbugDb,
  closeLbug,
  closeLbugBeforeExit,
  loadCachedEmbeddings,
  deleteNodesForFiles,
  deleteAllCommunitiesAndProcesses,
  deleteAllInterprocTaintPaths,
  deleteAllCallSummaries,
  deleteAllInjects,
  queryImportersBatch,
  loadFTSExtension,
  recreateCodeEmbeddingTable,
  loadVectorExtension,
  createVectorIndex,
  dropVectorIndex,
  wipeLbugDbFiles,
  LbugWipeError,
  DELETE_FILES_CHUNK_SIZE,
  inspectEmbeddingIntegrity,
  type EmbeddingIntegrityReport,
} from './lbug/lbug-adapter.js';
import { estimateBufferPool, setBufferPoolSizeHint } from './lbug/lbug-config.js';
import { escapeCypherString } from './lbug/cypher-escape.js';
import {
  createSearchFTSIndexes,
  initialiseSearchFTSStemmer,
  verifySearchFTSIndexes,
} from './search/fts-indexes.js';
import {
  cjkSegmentationModeMismatch,
  getSearchFTSCjkSegmentation,
  initialiseSearchFTSCjkSegmentation,
} from './search/cjk-segmentation.js';
import { getExtensionCapabilities, resolveAnalyzeInstallPolicy } from './lbug/extension-loader.js';
import { diagnoseExtensionLoad } from './lbug/extension-load-error.js';
import {
  startWalCheckpointDriver,
  checkpointOnce,
  type WalCheckpointDriver,
} from './lbug/wal-checkpoint-driver.js';
import { quarantineSidecarsForDirtyRecovery } from './lbug/sidecar-recovery.js';
import {
  getStoragePaths,
  resolveBranchPlacement,
  branchSlug,
  saveMeta,
  loadMeta,
  ensureGitNexusIgnored,
  registerRepo,
  assertCanonicalRepositoryIdentity,
  adoptFlatBranchLabel,
  isReadOnlyFilesystemError,
  isRepoRegistered,
  cleanupOldKuzuFiles,
  reconcileMetadataFiles,
  isMissingFilesystemError,
  canonicalizePath,
  registryPathEquals,
  INDEX_METADATA_FILE,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../storage/repo-manager.js';
import { DEFAULT_PDG_MAX_FUNCTION_LINES } from './ingestion/cfg/collect.js';
import {
  DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
  DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
  DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION,
} from './ingestion/cfg/emit.js';
import {
  DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
  DEFAULT_PDG_MAX_TAINT_HOPS,
} from './ingestion/taint/propagate.js';
import {
  DEFAULT_MAX_INTERPROC_HOPS,
  DEFAULT_PDG_MAX_INTERPROC_FINDINGS,
} from './ingestion/taint/interproc-solver.js';
import { DEFAULT_PDG_MAX_INTERPROC_EDGES } from './ingestion/taint/interproc-emit.js';
import { taintModelVersion } from './ingestion/taint/typescript-model.js';
import { parseTruthyEnv, parsePositiveIntEnv } from './ingestion/utils/env.js';
import {
  assertCompletedCheckpointIdentity,
  assertEmbeddingIntegrity,
  embeddingIntegrityIsClean,
  embeddingIntegritySummary,
} from './embeddings/checkpoint-identity.js';
import { computeFileHashes, diffFileHashes } from '../storage/file-hash.js';
import {
  extractChangedSubgraph,
  computeEffectiveWriteSet,
} from './incremental/subgraph-extract.js';
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import { shouldEscalateIncrementalWrite } from './incremental/escalation-gate.js';
import {
  loadParseCache,
  saveParseCache,
  pruneCache,
  PARSE_CACHE_VERSION,
} from '../storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../storage/parsedfile-store.js';
import {
  getCurrentCommit,
  getCurrentBranch,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import {
  createEmbeddingSnapshot,
  EMBEDDING_PRESERVATION_BATCH_SIZE,
  EMBEDDING_SNAPSHOT_FILE,
  readEmbeddingSnapshot,
  removeEmbeddingSnapshot,
  validateEmbeddingSnapshot,
  embeddingSnapshotMatchesIdentityDigest,
  type EmbeddingSnapshotInfo,
} from './embeddings/cache-snapshot.js';
import {
  removeEmbeddingTableRebuildMarker,
  validateEmbeddingTableRebuildMarker,
  writeEmbeddingTableRebuildMarker,
} from './embeddings/rebuild-marker.js';
import type { EmbeddingIdentity } from './embeddings/embedding-identity.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { sanitizeDetectedBranch } from '../cli/analyze-config.js';
import { EMBEDDING_TABLE_NAME, STALE_HASH_SENTINEL } from './lbug/schema.js';
import { isMissingColumnOrTableError } from './lbug/schema-errors.js';
import {
  discardStagedWorkspace,
  getStagedAnalyzePaths,
  hasPendingPromotion,
  inspectStagedWorkspaceSource,
  prepareStagedWorkspace,
  promoteStagedGeneration,
  validateStagedGeneration,
  withAnalyzeOwnershipLock,
  type RepositorySourceIdentity,
  type StagedAnalyzePaths,
} from './staged-promotion.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
  /** Test/recovery observability at durable incremental-write boundaries. */
  onRecoveryBoundary?: (
    boundary: 'before-delete' | 'during-delete' | 'during-insert' | 'before-finalize',
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface AnalyzeOptions {
  /**
   * Internal server-only display path. Filesystem work stays bound to the
   * canonical `repoPath` argument while metadata and registry projections keep
   * the stable path the operator registered.
   */
  registryPath?: string;
  /**
   * Internal server-only physical storage target captured before the shared
   * repository lock is acquired. Never canonicalize this value again: doing
   * so after a `.gitnexus` symlink retarget would escape the held lock.
   */
  analyzeStoragePath?: string;
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  /** Build and validate a shadow DB, then promote it through a durable journal. */
  staged?: boolean;
  /**
   * Refuse every path that would require a full DB rebuild. The preflight is
   * intentionally stricter than normal analyze: it runs before migration
   * cleanup, metadata reconciliation, sidecar recovery, or any DB open.
   */
  incrementalOnly?: boolean;
  /** Repair only search indexes without re-running full parsing/indexing. */
  repairFts?: boolean;
  /** Rebuild only the named HNSW index while preserving every embedding row. */
  repairVector?: boolean;
  /** Emit per-index FTS create logs. */
  verbose?: boolean;
  embeddings?: boolean;
  /**
   * Override the auto-skip node-count cap for embedding generation.
   * `undefined` uses the 50,000-node local-model default and no automatic cap
   * for remote HTTP providers; `0` disables the cap entirely; any positive
   * integer sets an explicit cap for either provider type.
   * Mapped from the CLI's `--embeddings [limit]` argument.
   */
  embeddingsNodeLimit?: number;
  /**
   * Explicitly drop any embeddings present in the existing index instead of
   * preserving them. Only meaningful when `embeddings` is false/undefined:
   * the default behavior in that case is to load the previously generated
   * embeddings and re-insert them after the rebuild so a routine
   * re-analyze does not silently wipe a long embedding pass (#issue: analyze
   * silently wipes existing embeddings when run without --embeddings).
   */
  dropEmbeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /** Skip installing standard GitNexus skill files to .claude/skills/gitnexus/. */
  skipSkills?: boolean;
  /**
   * Build the CFG/PDG substrate (#2081 M1). Forwarded to `PipelineOptions.pdg`,
   * which threads to BOTH the worker (CFG build, via workerData) AND
   * scope-resolution (BasicBlock/CFG emit gate). Off by default.
   */
  pdg?: boolean;
  /** Per-function source-line cap for worker-side CFG construction (#2081 M1).
   *  Forwarded to `PipelineOptions.pdgMaxFunctionLines`. No CLI flag in M1 —
   *  programmatic / server analyze-worker path only; the worker applies
   *  `DEFAULT_PDG_MAX_FUNCTION_LINES` when unset. */
  pdgMaxFunctionLines?: number;
  /** Per-function CFG edge cap. Forwarded to `PipelineOptions.pdgMaxEdgesPerFunction`. */
  pdgMaxEdgesPerFunction?: number;
  /** Per-function REACHING_DEF edge cap (#2082 M2). Forwarded to
   *  `PipelineOptions.pdgMaxReachingDefEdgesPerFunction`. */
  pdgMaxReachingDefEdgesPerFunction?: number;
  /** Per-function CDG edge cap (#2085 M5). Forwarded to
   *  `PipelineOptions.pdgMaxCdgEdgesPerFunction`. No CLI flag or rc key —
   *  programmatic / server path only, like the other pdg caps. */
  pdgMaxCdgEdgesPerFunction?: number;
  /** Per-function taint findings cap (#2083 M3). Forwarded to
   *  `PipelineOptions.pdgMaxTaintFindingsPerFunction`. No CLI flag or rc key
   *  (KTD8) — programmatic / server path only, like the other pdg caps. */
  pdgMaxTaintFindingsPerFunction?: number;
  /** Per-finding taint hop cap (#2083 M3, KTD6). Forwarded to
   *  `PipelineOptions.pdgMaxTaintHops`. No CLI flag or rc key (KTD8). */
  pdgMaxTaintHops?: number;
  /** Per-run cross-function findings/hops/edges caps (#2084 review P1-3).
   *  Forwarded to the matching `PipelineOptions.pdgMaxInterproc*`; resolved
   *  into `RepoMeta.pdg`. No CLI flag or rc key (KTD8). */
  pdgMaxInterprocFindings?: number;
  pdgMaxInterprocHops?: number;
  pdgMaxInterprocEdges?: number;
  /**
   * Stream the BasicBlock + intra-file PDG-edge layer to CSV-on-disk during the
   * emit loop instead of materializing it in the in-memory graph, bounding peak
   * RSS to O(chunk) for full-kernel-scale repos (#2202). Only engages on a full
   * rebuild — `resolveStreamPdgEmit` additionally requires `force === true`
   * (the pre-pipeline guarantee of a full rebuild). May also be enabled via
   * `GITNEXUS_STREAM_PDG_EMIT`. Memory-only; byte-identical output; not stamped
   * into `RepoMeta.pdg`. */
  streamPdgEmit?: boolean;
  /** Streamed PDG-emit write buffer (rows). `undefined` ⇒
   *  `DEFAULT_PDG_EMIT_CHUNK_ROWS`. May also be set via
   *  `GITNEXUS_PDG_EMIT_CHUNK_SIZE`. Memory-only (#2202). */
  pdgEmitChunkSize?: number;
  /**
   * Default branch threaded into generated AGENTS.md / CLAUDE.md so the
   * regression-compare example uses the configured branch instead of a
   * hardcoded "main" (#243). Resolved by the CLI; `undefined` here keeps the
   * "main" fallback for non-CLI callers (e.g. the server analyze worker).
   */
  defaultBranch?: string;
  /**
   * Index-branch selector (#2106, #2354). Distinct from `defaultBranch` (which
   * only affects generated AGENTS.md/CLAUDE.md base_ref text). When set, this
   * run is pinned to a per-branch index slot (`branches/<slug>/`) unless the
   * label matches the flat slot's recorded branch. When `undefined`, the run
   * always targets the flat workspace slot, which follows the checked-out
   * working tree; the auto-detected branch is only recorded as the slot's
   * informational label. Detached HEAD / non-git also map to the flat slot.
   */
  branch?: string;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
  /**
   * Worker pool size override, threaded from the CLI `--workers` flag.
   * Forwarded to `PipelineOptions.workerPoolSize` so the parse phase
   * sizes the pool without `analyzeCommand` mutating `process.env`.
   * Must be a positive integer — `0` hard-errors (sequential parsing was
   * removed); `undefined` defers to the env / auto-formula fallback.
   */
  workerPoolSize?: number;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers, forwarded to
   * `PipelineOptions.fetchWrappers` (#1589/#1852 residual). Sourced from the CLI
   * `.gitnexusrc` `fetchWrappers` list. `undefined`/empty leaves the route
   * consumer scan unchanged.
   */
  fetchWrappers?: string[];
  /**
   * The caller will `process.exit()` immediately after this analyze returns (the
   * CLI `analyze` command). When set, the finalize/error close CHECKPOINTs for
   * durability but skips the native `conn.close()`/`db.close()`, which can
   * double-free in LadybugDB's `ClientContext` destructor after large `--pdg`
   * writes (gdb-confirmed) — aborting the process AFTER a fully-written index.
   * Process exit reclaims the handles. Long-lived callers (MCP server, tests)
   * leave this unset so they get a real close. See `closeLbug`. */
  skipNativeCloseOnExit?: boolean;
}

const resolveEmbeddingIdentity = async (): Promise<EmbeddingIdentity> => {
  const { getActiveEmbeddingIdentity } = await import('./embeddings/embedder.js');
  return getActiveEmbeddingIdentity();
};

export const shouldRecreateStagedEmbeddingTableForResume = (
  rebuild: boolean,
  snapshotInfo: EmbeddingSnapshotInfo | undefined,
): snapshotInfo is EmbeddingSnapshotInfo => rebuild && snapshotInfo !== undefined;

const pathKind = (state: Awaited<ReturnType<typeof fs.lstat>>): string => {
  if (state.isSymbolicLink()) return 'a symbolic link';
  if (state.isDirectory()) return 'a directory';
  if (state.isSocket()) return 'a socket';
  if (state.isFIFO()) return 'a FIFO';
  if (state.isBlockDevice()) return 'a block device';
  if (state.isCharacterDevice()) return 'a character device';
  return 'not a regular file';
};

const lstatIfPresent = async (targetPath: string) => {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingFilesystemError(error)) return null;
    throw error;
  }
};

/**
 * Read-only gate for VECTOR maintenance. It deliberately runs before the
 * analyzer ownership lock creates any file, and refuses rather than recovering
 * stale state. A second writer that appears after this check is still excluded
 * by the ownership/init/database locks.
 */
export const assertVectorRepairPreflight = async (
  repoPath: string,
  options: { allowAnalyzeOwnershipLock?: boolean } = {},
): Promise<RepoMeta> => {
  const paths = getStoragePaths(repoPath);
  const storageState = await lstatIfPresent(paths.storagePath);
  if (!storageState) {
    throw new Error('Cannot repair VECTOR: this repository has not been analyzed yet.');
  }
  if (!storageState.isDirectory() || storageState.isSymbolicLink()) {
    throw new Error(
      `Cannot repair VECTOR: storage at ${paths.storagePath} is ${pathKind(storageState)}; ` +
        'expected a regular directory.',
    );
  }

  const databaseState = await lstatIfPresent(paths.lbugPath);
  if (!databaseState) {
    throw new Error(`Cannot repair VECTOR: graph store at ${paths.lbugPath} is missing.`);
  }
  if (!databaseState.isFile() || databaseState.isSymbolicLink()) {
    throw new Error(
      `Cannot repair VECTOR: graph store at ${paths.lbugPath} is ${pathKind(databaseState)}; ` +
        'expected a regular file.',
    );
  }

  const promotion = getStagedAnalyzePaths(paths.lbugPath, path.dirname(paths.metaPath));
  const blockedArtifacts = [
    !options.allowAnalyzeOwnershipLock && path.join(paths.storagePath, 'analyze-staged.lock'),
    `${paths.lbugPath}.init.lock`,
    `${paths.lbugPath}.lock`,
    `${paths.lbugPath}.wal`,
    `${paths.lbugPath}.shadow`,
    `${paths.lbugPath}.wal.checkpoint`,
    promotion.journalPath,
    promotion.stageIntentPath,
    promotion.stageRoot,
    promotion.backupLbugPath,
  ].filter((artifact): artifact is string => typeof artifact === 'string');
  for (const artifact of blockedArtifacts) {
    if (await lstatIfPresent(artifact)) {
      throw new Error(
        `Cannot repair VECTOR while lock or recovery state is present at ${artifact}. ` +
          'Resolve it with the normal analyze/recovery workflow first.',
      );
    }
  }

  const meta = await loadMeta(path.dirname(paths.metaPath));
  if (!meta) throw new Error('Cannot repair VECTOR: index metadata is missing.');
  // A checkpoint whose window is fully persisted (all nodes processed, no
  // pending window) only means the run died between the last embedding write
  // and finalize — the embedding table is complete, and the repair path still
  // verifies it via inspectEmbeddingIntegrity before, during, and after the
  // rebuild. Refusing it forces a full re-embed for an index that is already
  // whole (#132). A pending window may hold partially persisted chunk rows, so
  // it stays blocking, as does any in-progress incremental write.
  const checkpoint = meta.embeddingCheckpoint;
  const checkpointComplete =
    checkpoint !== undefined &&
    checkpoint.nodesProcessed === checkpoint.totalNodes &&
    !checkpoint.pendingNodeIds?.length;
  if (meta.incrementalInProgress || (checkpoint && !checkpointComplete)) {
    throw new Error(
      'Cannot repair VECTOR while index metadata records an incomplete analysis or embedding checkpoint.',
    );
  }
  if (checkpoint && checkpointComplete) {
    if (checkpoint.provider === undefined && checkpoint.totalNodes === 0) return meta;
    // The checkpoint is the only durable record of which model produced the
    // stored vectors. The resume path refuses a model/dimension mismatch, and
    // repair clears the checkpoint on success — so repairing through a
    // mismatched identity would build HNSW over incompatible rows AND erase
    // the evidence. Mirror the resume-path guard before allowing either.
    const identity = await resolveEmbeddingIdentity();
    if (
      checkpoint.provider === undefined ||
      checkpoint.provider !== identity.provider ||
      checkpoint.model !== identity.model ||
      checkpoint.dimensions !== identity.dimensions
    ) {
      throw new Error(
        `Cannot repair VECTOR: the completed embedding checkpoint records ${checkpoint.provider ?? 'unknown-provider'} / ` +
          `${checkpoint.model} at ${checkpoint.dimensions} dimensions, but this run resolves ` +
          `${identity.provider} / ${identity.model} at ${identity.dimensions}. Restore the matching ` +
          'embedding configuration, or rebuild with analyze --drop-embeddings --embeddings 0.',
      );
    }
  }
  return meta;
};

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /**
   * True when this invocation only completed a previously journaled staged
   * promotion. The recovered generation is durable and registered, but the
   * current checkout was deliberately not analyzed in the same invocation.
   */
  recoveredPromotionOnly?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
  /** True when analyze only repaired FTS indexes and skipped pipeline re-analysis. */
  ftsRepairedOnly?: boolean;
  /** Terminal outcome for a VECTOR-only maintenance run. */
  vectorRepairStatus?: 'repaired' | 'healthy' | 'not-indexed';
  /**
   * True when the FTS extension was unavailable so search-index creation was
   * skipped (offline-first degradation). The graph is fully queryable; only
   * full-text/BM25 search is disabled. Lets callers (CLI summary, server) and
   * the persisted meta surface the degraded state instead of reporting healthy.
   */
  ftsSkipped?: boolean;
  /**
   * True when the index this run produced/validated is the flat workspace
   * slot (#2106 R2, inverted by #2354 to follow the checked-out branch).
   * `false` for a pinned `--branch` sub-index. Lets the CLI skip repo-root
   * AGENTS.md/CLAUDE.md refreshes (e.g. the base_ref fast-path) for a pinned
   * branch analyze, mirroring the in-pipeline `if (!placement.branch)` gate.
   * (The historical "primary" name is kept — it is public API surface.)
   */
  isPrimaryBranch?: boolean;
}

/**
 * Logged when the optional FTS extension cannot be loaded or installed during
 * a full analyze. Kept as a named constant so the env-var/command guidance
 * stays in one place (mirrors the VECTOR message in embedding-pipeline.ts).
 */
// Class-neutral lead, reused for the missing-dependency degrade path (#2383 F2):
// its remedy already explains that reinstalling will NOT help, so appending the
// generic "install with network access" tail below would contradict it.
const FTS_UNAVAILABLE_LEAD = 'FTS extension unavailable; skipping search-index creation.';
const FTS_UNAVAILABLE_MESSAGE =
  `${FTS_UNAVAILABLE_LEAD} ` +
  'Full-text/BM25 search will be disabled until the LadybugDB FTS extension is ' +
  'installed once with network access (GITNEXUS_LBUG_EXTENSION_INSTALL=auto) or ' +
  'pre-installed for offline use. Run `gitnexus doctor` for details.';
const CLI_CHECKPOINT_CONTEXT =
  'Cannot resume embedding checkpoint. Manual recovery required: do not retry ' +
  '`gitnexus analyze`. ' +
  'Run `gitnexus analyze --force --drop-embeddings --embeddings 0`.';

// Re-export the pure flag-derivation helper so external callers (and tests)
// keep importing from this module's stable surface.
export { deriveEmbeddingMode, DEFAULT_EMBEDDING_NODE_LIMIT } from './embedding-mode.js';
export type { EmbeddingMode } from './embedding-mode.js';
import {
  deriveEmbeddingMode as _deriveEmbeddingMode,
  deriveEmbeddingCap,
  resolveEmbeddingNodeLimit,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from './embedding-mode.js';

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  scopeResolution: 'Resolving types',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
/**
 * Collect the recorded parse-cache chunk keys across the flat + every branch
 * metadata directory under a flat `.gitnexus` storage, EXCLUDING `excludeDir`
 * (the current run's own meta dir) so a single-branch repo collects nothing and
 * its prune stays byte-identical to today (#2106 R6 — the byte-identity claim
 * is about the PRUNE result; the metadata FILENAME read here changed with
 * PR #2363's rename, checking `gitnexus.json` first then the legacy
 * `meta.json` mirror). `complete` is false when a sibling metadata file exists
 * but fails to read or parse — callers then retain the whole shared cache
 * rather than over-evict another branch's still-live shards. Exported for
 * testing.
 */
export const collectBranchCacheKeys = async (
  storagePath: string,
  excludeDir?: string,
): Promise<{ keys: Set<string>; complete: boolean }> => {
  const keys = new Set<string>();
  let complete = true;
  const metaDirs = [storagePath];
  const branchesDir = path.join(storagePath, 'branches');
  const slugs = await fs.readdir(branchesDir).catch(() => [] as string[]);
  for (const slug of slugs) metaDirs.push(path.join(branchesDir, slug));
  for (const dir of metaDirs) {
    if (excludeDir && path.resolve(dir) === path.resolve(excludeDir)) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, INDEX_METADATA_FILE), 'utf-8');
    } catch (newErr) {
      if (!isMissingFilesystemError(newErr)) {
        complete = false;
        continue;
      }
      try {
        raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf-8');
      } catch (legacyErr) {
        if (!isMissingFilesystemError(legacyErr)) complete = false;
        continue; // no metadata here — not a branch index, not a failure
      }
    }
    try {
      const parsed = JSON.parse(raw) as { cacheKeys?: unknown };
      if (Array.isArray(parsed.cacheKeys)) {
        for (const k of parsed.cacheKeys) if (typeof k === 'string') keys.add(k);
      }
    } catch {
      complete = false; // present but corrupt → fail-safe toward retention
    }
  }
  return { keys, complete };
};

/**
 * Resolve the requested `--pdg` configuration to the shape recorded in
 * `RepoMeta.pdg`, or `undefined` for a pdg-off run. Caps resolve to their
 * defaults so an explicit-default run compares equal to a default run
 * (`0` = unlimited is preserved as `0`). Pure + exported for testing.
 */
type PdgOptions = Pick<
  AnalyzeOptions,
  | 'pdg'
  | 'pdgMaxFunctionLines'
  | 'pdgMaxEdgesPerFunction'
  | 'pdgMaxReachingDefEdgesPerFunction'
  | 'pdgMaxCdgEdgesPerFunction'
  | 'pdgMaxTaintFindingsPerFunction'
  | 'pdgMaxTaintHops'
  | 'pdgMaxInterprocFindings'
  | 'pdgMaxInterprocHops'
  | 'pdgMaxInterprocEdges'
>;

export const resolvePdgConfig = (options: PdgOptions): RepoMeta['pdg'] =>
  options.pdg === true
    ? {
        maxFunctionLines: options.pdgMaxFunctionLines ?? DEFAULT_PDG_MAX_FUNCTION_LINES,
        maxEdgesPerFunction: options.pdgMaxEdgesPerFunction ?? DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
        maxReachingDefEdgesPerFunction:
          options.pdgMaxReachingDefEdgesPerFunction ??
          DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
        // #2085 M5: control-dependence cap. Absent on any pre-M5 (M2/M3/M4-era)
        // stamp → the key-union pdgModeMismatch trips the first CDG-aware run
        // over an existing `--pdg` index and forces the full writeback that
        // materialises CDG edges for every file without `--force`.
        maxCdgEdgesPerFunction:
          options.pdgMaxCdgEdgesPerFunction ?? DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION,
        // #2083 M3: taint caps + model identity. The key-union comparator in
        // pdgModeMismatch picks these up structurally — an M2-era stamp lacks
        // all three, so the first M3 run over an M2 `--pdg` index trips a full
        // writeback that populates TAINTED/SANITIZES rows without `--force`.
        maxTaintFindingsPerFunction:
          options.pdgMaxTaintFindingsPerFunction ?? DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
        maxTaintHops: options.pdgMaxTaintHops ?? DEFAULT_PDG_MAX_TAINT_HOPS,
        // #2084 review P1-3: cross-function caps. Absent on an M3-era stamp →
        // pdgModeMismatch trips the first run that adds them (key-union),
        // forcing the full writeback that re-materialises TAINT_PATH bounded.
        maxInterprocFindings: options.pdgMaxInterprocFindings ?? DEFAULT_PDG_MAX_INTERPROC_FINDINGS,
        maxInterprocHops: options.pdgMaxInterprocHops ?? DEFAULT_MAX_INTERPROC_HOPS,
        maxInterprocEdges: options.pdgMaxInterprocEdges ?? DEFAULT_PDG_MAX_INTERPROC_EDGES,
        // Built-in model digest (KTD7/R7): persisted findings must never
        // outlive the model that produced them — ANY model-content change
        // ships as a new digest and repopulates the taint edges.
        taintModelVersion,
        // #2201 review R3: reaching-defs solver identity. The SSA-sparse rewrite
        // computes full facts for deep-loop functions the dense worklist used to
        // truncate to empty, so an existing `--pdg` index carries stale-truncated
        // REACHING_DEF rows. Absent on any pre-#2201 stamp → the key-union
        // pdgModeMismatch trips on the first upgraded run and forces the full
        // writeback that recomputes the fuller coverage (no `--force` needed).
        // Bump this tag on any future change to which facts the solver emits.
        reachingDefSolver: 'ssa-sparse-v1',
        // PDG FU-C: this run records CALL_SUMMARY return-value-ascent edges.
        // Absent on any pre-FU-C (v3) stamp → the key-union pdgModeMismatch trips
        // the first FU-C-aware run over an existing `--pdg` index and forces the
        // full writeback that materialises CALL_SUMMARY edges without `--force`;
        // and `impact`'s PDG mode reads its absence to note "no return-value
        // ascent (re-index for CALL_SUMMARY)" on a v3 index (intra slice intact).
        hasCallSummary: true,
      }
    : undefined;

/**
 * Whether streaming/chunked PDG graph emit (#2202) engages this run.
 *
 * Streaming flushes the BasicBlock + intra-file PDG-edge layer to CSV-on-disk
 * during the emit loop and never lands it in the in-memory graph, bounding peak
 * RSS to O(chunk). It is sound ONLY on a full rebuild: the incremental
 * writeback (`extractChangedSubgraph`) reads BasicBlock nodes back out of the
 * in-memory graph, which streaming has already offloaded. `force === true` is
 * the pre-pipeline guarantee of a full rebuild — `isIncremental` has
 * `!force` as a necessary condition — so gating on it avoids the deliberately
 * absent pre-pipeline incremental prediction (see the `isIncremental` note).
 *
 * Requires `pdg === true` (nothing to stream otherwise). Enabled by either the
 * explicit `streamPdgEmit` option or the `GITNEXUS_STREAM_PDG_EMIT` env toggle.
 * Memory-only — NOT part of {@link resolvePdgConfig}, so toggling it never
 * trips `pdgModeMismatch`. Read every call (not memoized) so `vi.stubEnv`
 * works in tests. Pure + exported for testing.
 */
export const resolveStreamPdgEmit = (options: {
  pdg?: boolean;
  force?: boolean;
  streamPdgEmit?: boolean;
}): boolean =>
  options.pdg === true &&
  options.force === true &&
  (options.streamPdgEmit === true || parseTruthyEnv(process.env.GITNEXUS_STREAM_PDG_EMIT));

/**
 * Resolve the streamed PDG-emit write-buffer size (#2202). Explicit option wins
 * over `GITNEXUS_PDG_EMIT_CHUNK_SIZE`; `undefined` ⇒ the sink's
 * `DEFAULT_PDG_EMIT_CHUNK_ROWS`. Memory-only; does not affect emitted bytes.
 */
export const resolvePdgEmitChunkSize = (options: {
  pdgEmitChunkSize?: number;
}): number | undefined => {
  // Only honor a positive-integer explicit option; `0`/negative is NOT nullish
  // so `?? env` would pass it through and make the sink flush every row.
  const opt = options.pdgEmitChunkSize;
  if (opt !== undefined && Number.isInteger(opt) && opt > 0) return opt;
  return parsePositiveIntEnv(process.env.GITNEXUS_PDG_EMIT_CHUNK_SIZE);
};

/**
 * Whether the requested `--pdg` configuration differs from the one the
 * existing index's DB rows were built under (#2099 F1). An absent recorded
 * stamp means pdg-off (every legacy meta — `--pdg` shipped opt-in). Any
 * mismatch means the incremental writeback (which only persists changed-file
 * nodes) cannot produce a coherent index: off→on would silently drop the
 * freshly built CFG layer, on→off would strand zombie BasicBlocks — so the
 * caller forces a full writeback. Pure + exported for testing.
 */
export const pdgModeMismatch = (recorded: RepoMeta['pdg'], options: PdgOptions): boolean => {
  const requested = resolvePdgConfig(options);
  if (!requested && !recorded) return false;
  if (!requested || !recorded) return true;
  // Structural comparison over the KEY UNION of both resolved records — not a
  // hand-maintained field list. Both sides come fully resolved from
  // resolvePdgConfig, so any new emit-affecting knob added there joins the
  // comparison automatically (M1's hand-extended comparator was the trap this
  // closes: a knob it missed would silently strand a stale projection). It is
  // also what makes the M1→M2 upgrade work with zero extra code: an M1-era
  // stamp lacks maxReachingDefEdgesPerFunction, so `4000 !== undefined` trips
  // a full writeback that populates REACHING_DEF rows without `--force`.
  const reqRecord = requested as Record<string, unknown>;
  const recRecord = recorded as Record<string, unknown>;
  // INVARIANT: every value stamped by resolvePdgConfig MUST be a SCALAR (string /
  // number / boolean). This comparison is a shallow `!==`, so an OBJECT or ARRAY
  // value would compare by REFERENCE — two structurally-equal values from
  // different runs would always be `!==`, tripping pdgModeMismatch on every
  // re-analyze and forcing a needless full writeback. e.g. do NOT change
  // `hasCallSummary: true` to a per-language object like `{ ts: true, ... }`; keep
  // the diagnostic per-language refinement in the impact CONSUMER (see
  // pdg-impact.ts assemblePdgImpactResult), not in this version discriminator.
  for (const key of new Set([...Object.keys(reqRecord), ...Object.keys(recRecord)])) {
    if (reqRecord[key] !== recRecord[key]) return true;
  }
  return false;
};

const runFullAnalysisImpl = async (
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  repositoryIdentity: { repoHasGit: boolean; remoteUrl: string | undefined },
): Promise<AnalyzeResult> => {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { repoHasGit, remoteUrl: repositoryRemoteUrl } = repositoryIdentity;
  const persistedRepoPath = options.registryPath ?? repoPath;
  const expectedPersistedCanonicalPath = canonicalizePath(repoPath);
  const frozenRegistryIdentity = {
    expectedCanonicalPath: expectedPersistedCanonicalPath,
    ...(options.analyzeStoragePath
      ? { expectedCanonicalStoragePath: options.analyzeStoragePath }
      : {}),
  };

  // Resolve + validate operator-provided FTS config once, before the expensive
  // parse/load phases. A typo fails here in ms; createSearchFTSIndexes reuses
  // the cached value via getSearchFTSStemmer.
  initialiseSearchFTSStemmer();
  initialiseSearchFTSCjkSegmentation();

  // Scope the degraded-parse log throttle to this run. On a reused process
  // (e.g. tests, or any host that calls runFullAnalysis more than once) the
  // module-level counter would otherwise stay saturated and suppress every
  // degraded-parse log after the first run. The per-parse worker holds its own
  // counter in its own module instance and is process-scoped, so no separate
  // worker-side reset is needed (see safe-parse.ts ParseTimeoutError contract).
  resetDegradedParseCounter();

  const incrementalOnlyStop = (reason: string): never => {
    throw new Error(
      `Incremental-only safety stop: ${reason}. ` +
        'No recovery or full-rebuild mutation was started. ' +
        'Run `gitnexus doctor --recovery-plan` to inspect the existing index.',
    );
  };

  // `storagePath` is ALWAYS the flat `.gitnexus` — content-addressed caches
  // (parse-cache, parsedfile-store) and the kuzu-migration cleanup live there
  // and are shared across branches (#2106 KTD7).
  const storagePath = options.analyzeStoragePath ?? getStoragePaths(repoPath).storagePath;

  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';

  // ── #2106/#2354: resolve which branch slot this run writes to ─────────
  // `branchLabel` is the branch identity recorded in meta.json (incl. the
  // flat workspace slot). `placement.branch` is undefined for the flat slot
  // (the lbug/meta paths stay byte-identical to single-branch behavior) and
  // set for a `branches/<slug>/` sub-directory. Only an explicit `--branch`
  // can route to a sub-directory; a plain analyze ALWAYS targets the flat
  // slot, which follows the checked-out working tree (#2354) — the
  // auto-detected branch (null for detached HEAD / non-git) is recorded as
  // the slot's informational label only.
  // Normalize the auto-detected branch the same way an explicit `--branch` is
  // validated (#2106 R1): a git ref the branch-name rules forbid (backtick,
  // `~ ^ : ? *`, leading `-`, `..`) becomes `null` → the flat slot, matching
  // that a later `--branch <that-ref>` query would also be rejected. A normal
  // ref passes through unchanged so index-time and query-time labels round-trip.
  const rawCheckedOutBranch = repoHasGit ? getCurrentBranch(repoPath) : null;
  const checkedOutBranch = sanitizeDetectedBranch(rawCheckedOutBranch) ?? null;
  const repositorySource: RepositorySourceIdentity = {
    head: currentCommit,
    branch: rawCheckedOutBranch,
  };
  const readRepositoryIdentity = (): RepositorySourceIdentity => ({
    head: repoHasGit ? getCurrentCommit(repoPath) : '',
    branch: repoHasGit ? getCurrentBranch(repoPath) : null,
  });
  const branchLabel = options.branch ?? checkedOutBranch;
  const placement = options.branch ? await resolveBranchPlacement(repoPath, branchLabel) : {};
  const canonicalPaths = options.analyzeStoragePath
    ? {
        storagePath,
        lbugPath: path.join(
          placement.branch
            ? path.join(storagePath, 'branches', branchSlug(placement.branch))
            : storagePath,
          'lbug',
        ),
        metaPath: path.join(
          placement.branch
            ? path.join(storagePath, 'branches', branchSlug(placement.branch))
            : storagePath,
          INDEX_METADATA_FILE,
        ),
      }
    : getStoragePaths(repoPath, placement.branch);
  // Prevent a previous analyze in the same process from leaking its graph hint
  // into any pre-pipeline database open in this run.
  setBufferPoolSizeHint(undefined);
  const canonicalMetaDir = path.dirname(canonicalPaths.metaPath);
  const promotionPaths = getStagedAnalyzePaths(canonicalPaths.lbugPath, canonicalMetaDir);
  const stagedPaths: StagedAnalyzePaths | undefined = options.staged ? promotionPaths : undefined;

  // A plain analyze of the flat slot may be switching its informational
  // branch label. Until registry adoption commits, every durable metadata
  // projection retains exactly the branch property that existed at entry
  // (including property absence). This keeps checkpoints and ordinary or
  // recovered staged promotions retryable after any partial failure.
  const implicitFlatBranch =
    !options.branch && !placement.branch && branchLabel ? branchLabel : null;
  const canonicalMetaBeforeAdoption = implicitFlatBranch ? await loadMeta(canonicalMetaDir) : null;
  const canonicalBranchExistedBeforeAdoption =
    canonicalMetaBeforeAdoption !== null &&
    Object.prototype.hasOwnProperty.call(canonicalMetaBeforeAdoption, 'branch');
  const canonicalBranchBeforeAdoption = canonicalMetaBeforeAdoption?.branch;
  const implicitFlatBranchAdoptionPending =
    implicitFlatBranch !== null &&
    (!canonicalBranchExistedBeforeAdoption || canonicalBranchBeforeAdoption !== implicitFlatBranch);
  const preservePreAdoptionBranch = (meta: RepoMeta): RepoMeta => {
    if (!implicitFlatBranch) return meta;
    const protectedMeta = { ...meta };
    if (canonicalBranchExistedBeforeAdoption) protectedMeta.branch = canonicalBranchBeforeAdoption;
    else delete protectedMeta.branch;
    return protectedMeta;
  };
  const markPendingImplicitFlatAdoption = (meta: RepoMeta): RepoMeta => {
    const protectedMeta = preservePreAdoptionBranch(meta);
    if (!implicitFlatBranchAdoptionPending || protectedMeta.incrementalInProgress) {
      return protectedMeta;
    }
    const now = Date.now();
    return {
      ...protectedMeta,
      incrementalInProgress: {
        startedAt: now,
        updatedAt: now,
        targetCommit: meta.lastCommit,
        phase: 'branch-adoption',
        toWriteCount: 0,
      },
    };
  };
  const savePreAdoptionMeta = (metaDir: string, meta: RepoMeta): Promise<void> =>
    saveMeta(metaDir, markPendingImplicitFlatAdoption(meta));
  const adoptAndRestampImplicitFlatBranch = async (meta: RepoMeta): Promise<RepoMeta> => {
    if (!implicitFlatBranch) return meta;
    const outcome = options.analyzeStoragePath
      ? await adoptFlatBranchLabel(repoPath, implicitFlatBranch, storagePath)
      : await adoptFlatBranchLabel(repoPath, implicitFlatBranch);
    if (outcome !== 'ADOPTED') {
      log(
        `Warning: workspace branch adoption returned ${outcome}; ` +
          'retaining the prior branch label and retry protection.',
      );
      return preservePreAdoptionBranch(meta);
    }
    // The staged commit callback may have persisted a protected copy that is
    // not the same object as `meta`. Inspect the canonical file itself before
    // taking the coherent-state shortcut, so a staged adoption marker cannot
    // survive just because the caller's copy was unmarked.
    const persistedMeta = await loadMeta(canonicalMetaDir);
    if (
      persistedMeta &&
      Object.prototype.hasOwnProperty.call(persistedMeta, 'branch') &&
      persistedMeta.branch === implicitFlatBranch &&
      persistedMeta.incrementalInProgress?.phase !== 'branch-adoption'
    ) {
      return meta;
    }
    const canonicalMeta = persistedMeta ?? meta;
    const dirtyPhase = canonicalMeta.incrementalInProgress;
    const adoptedMeta: RepoMeta = {
      ...canonicalMeta,
      ...meta,
      branch: implicitFlatBranch,
      incrementalInProgress:
        dirtyPhase?.phase === 'branch-adoption'
          ? undefined
          : (meta.incrementalInProgress ?? dirtyPhase),
    };
    await saveMeta(canonicalMetaDir, adoptedMeta);
    return adoptedMeta;
  };

  const commitStagedMetadataAndRegistry = async (
    meta: RepoMeta,
    pendingFlatAdoption = false,
  ): Promise<string> => {
    const protectedMeta = pendingFlatAdoption
      ? markPendingImplicitFlatAdoption(meta)
      : preservePreAdoptionBranch(meta);
    await saveMeta(canonicalMetaDir, protectedMeta);
    return registerRepo(persistedRepoPath, protectedMeta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
      branch: placement.branch,
      ...frozenRegistryIdentity,
    });
  };

  // ── VECTOR-only repair path ──────────────────────────────────────────
  // The outer entry point has already performed the read-only storage,
  // recovery, lock, and metadata preflight before acquiring our ownership
  // lock. This branch intentionally precedes staged-promotion recovery so a
  // maintenance command never mutates or chooses between recovery artifacts.
  if (options.repairVector) {
    const existingMeta = await loadMeta(canonicalMetaDir);
    if (!existingMeta) throw new Error('Cannot repair VECTOR: index metadata is missing.');

    const { probeDoctorPool, EXPECTED_POOL_CONNECTIONS } =
      await import('../cli/doctor-pool-probe.js');
    const readEmbeddingCount = async (): Promise<number> => {
      let rows: Awaited<ReturnType<typeof executeQuery>>;
      try {
        rows = await executeQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingColumnOrTableError(message)) return 0;
        throw error;
      }
      const row = rows[0];
      const count = Number(row?.cnt ?? row?.[0] ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Cannot repair VECTOR: database returned an invalid embedding count.');
      }
      return count;
    };
    let stats: { nodes: number; edges: number } = { nodes: 0, edges: 0 };
    let embeddingCountBefore = 0;
    let repairStatus: AnalyzeResult['vectorRepairStatus'] = 'healthy';

    // A writable LadybugDB open can change database bytes even when no Cypher
    // mutation is issued. Validate the source table through a native read-only
    // connection first so malformed and empty indexes fail/return without
    // touching the database file.
    let readOnlyPreflight: {
      stats: { nodes: number; edges: number };
      embeddingCount: number;
      integrity: EmbeddingIntegrityReport;
    };
    try {
      await initLbugReadOnlyNonRecovering(canonicalPaths.lbugPath);
      const embeddingCount = await readEmbeddingCount();
      readOnlyPreflight = {
        stats: await getLbugStats(),
        embeddingCount,
        integrity: await inspectEmbeddingIntegrity(),
      };
    } finally {
      await closeLbug().catch(() => {});
    }

    stats = readOnlyPreflight.stats;
    embeddingCountBefore = readOnlyPreflight.embeddingCount;
    if (existingMeta.embeddingCheckpoint) {
      if (existingMeta.embeddingCheckpoint.provider === undefined && embeddingCountBefore > 0) {
        throw new Error(
          'Cannot repair VECTOR: the completed embedding checkpoint has unknown-provider ' +
            'provenance while the table contains rows. Re-run analyze with ' +
            '--force --drop-embeddings --embeddings 0.',
        );
      }
      assertCompletedCheckpointIdentity(
        existingMeta.embeddingCheckpoint,
        readOnlyPreflight.integrity,
        'Cannot repair VECTOR: completed embedding checkpoint',
      );
    }

    // A completed checkpoint passed the preflight, so repair will clear it —
    // but the integrity scan only proves the live rows are well-formed, not
    // that none went missing after the final checkpoint (a dirty-recovery
    // discard can drop committed rows). stats.embeddings cannot serve as the
    // expectation: it is stale-low across the supported crash window (it is
    // finalized at run end) and stale-high when re-embedding legitimately
    // shrinks a node's chunk count (the server producer never persists a
    // count at all) — review on #192 produced counterexamples in both
    // directions. The only loss provable from the checkpoint alone is TOTAL
    // loss: it records embedded nodes, so an empty table is wrong in every
    // history. Refuse that here — before the zero-row branch below would
    // report a successful `not-indexed` — and leave partial-loss detection
    // to a persisted per-checkpoint row count (#194).
    if (
      existingMeta.embeddingCheckpoint &&
      existingMeta.embeddingCheckpoint.totalNodes > 0 &&
      embeddingCountBefore === 0
    ) {
      throw new Error(
        `Cannot repair VECTOR: the completed embedding checkpoint recorded ` +
          `${existingMeta.embeddingCheckpoint.totalNodes} embedded nodes but the table holds no ` +
          'rows. The embedding table was lost after the checkpoint; re-run analyze --embeddings 0 ' +
          'to regenerate it.',
      );
    }

    if (embeddingCountBefore === 0) {
      // Only a zero-node completed checkpoint reaches here (a populated one
      // threw above). Clear it before returning, or an empty repository stays
      // permanently marked as interrupted and later repair/resume keeps
      // observing stale recovery state.
      let projectName =
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath));
      let resultStats = {
        ...existingMeta.stats,
        nodes: stats.nodes,
        edges: stats.edges,
        embeddings: 0,
      };
      if (existingMeta.embeddingCheckpoint) {
        const clearedMeta = {
          ...existingMeta,
          stats: { ...existingMeta.stats, nodes: stats.nodes, edges: stats.edges, embeddings: 0 },
          embeddingCheckpoint: undefined,
          incrementalInProgress: undefined,
        };
        if (await isRepoRegistered(repoPath)) {
          projectName = await commitStagedMetadataAndRegistry(clearedMeta);
        } else {
          await savePreAdoptionMeta(canonicalMetaDir, clearedMeta);
        }
        resultStats = {
          ...clearedMeta.stats,
          nodes: stats.nodes,
          edges: stats.edges,
          embeddings: 0,
        };
      }
      progress('done', 100, 'No embeddings are indexed; VECTOR repair was not needed.');
      return {
        repoName: projectName,
        repoPath,
        stats: resultStats,
        vectorRepairStatus: 'not-indexed',
      };
    }

    assertEmbeddingIntegrity(
      readOnlyPreflight.integrity,
      'Cannot repair VECTOR: source table',
      embeddingCountBefore,
    );

    const beforeProbe = await probeDoctorPool(canonicalPaths.lbugPath);

    try {
      await initLbugForMaintenance(canonicalPaths.lbugPath);
      stats = await getLbugStats();
      const writableEmbeddingCount = await readEmbeddingCount();
      if (writableEmbeddingCount !== embeddingCountBefore) {
        throw new Error(
          `Cannot repair VECTOR: embedding rows changed after read-only preflight ` +
            `(${embeddingCountBefore} before, ${writableEmbeddingCount} current).`,
        );
      }

      assertEmbeddingIntegrity(
        await inspectEmbeddingIntegrity(),
        'Cannot repair VECTOR: source table',
        embeddingCountBefore,
      );

      if (beforeProbe.reason || !beforeProbe.vector) {
        throw new Error(
          'Cannot repair VECTOR: the production pool could not prove VECTOR availability ' +
            `(${beforeProbe.vectorIndexReason ?? beforeProbe.reason ?? 'vector-extension-unavailable'}).`,
        );
      }

      const vectorAvailable = await loadVectorExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (!vectorAvailable) {
        const rawReason = getExtensionCapabilities().find((c) => c.name === 'vector')?.reason;
        throw new Error(
          'Cannot repair VECTOR: the LadybugDB VECTOR extension is unavailable' +
            (rawReason ? ` — ${rawReason.replace(/\.$/, '')}` : '') +
            '.',
        );
      }

      if (!beforeProbe.vectorIndex) {
        progress('vector', 85, 'Rebuilding the HNSW vector index...');
        if (!(await dropVectorIndex())) {
          throw new Error('Cannot repair VECTOR: the existing HNSW index could not be removed.');
        }
        if (!(await createVectorIndex())) {
          throw new Error('Cannot repair VECTOR: the HNSW index could not be created.');
        }
        repairStatus = 'repaired';
      }

      const embeddingCountAfter = await readEmbeddingCount();
      if (embeddingCountAfter !== embeddingCountBefore) {
        throw new Error(
          `VECTOR repair changed embedding rows (${embeddingCountBefore} before, ` +
            `${embeddingCountAfter} after); metadata and registry were not updated.`,
        );
      }
    } finally {
      await closeLbug().catch(() => {});
    }

    const afterProbe = await probeDoctorPool(canonicalPaths.lbugPath);
    if (
      afterProbe.reason ||
      !afterProbe.vector ||
      !afterProbe.vectorIndex ||
      afterProbe.connectionCount !== EXPECTED_POOL_CONNECTIONS ||
      afterProbe.exercisedConnections !== EXPECTED_POOL_CONNECTIONS
    ) {
      throw new Error(
        'VECTOR repair did not pass the eight-connection production-pool probe; ' +
          `metadata and registry were not updated (${afterProbe.vectorIndexReason ?? afterProbe.reason ?? 'pool-probe-unavailable'}).`,
      );
    }

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    let repairedMeta: RepoMeta;
    let projectName: string;
    await initLbugForMaintenance(canonicalPaths.lbugPath);
    try {
      const committedStats = await getLbugStats();
      const committedEmbeddingCount = await readEmbeddingCount();
      if (committedEmbeddingCount !== embeddingCountBefore) {
        throw new Error(
          `VECTOR repair database changed before metadata commit (${embeddingCountBefore} ` +
            `verified, ${committedEmbeddingCount} current); metadata and registry were not updated.`,
        );
      }
      assertEmbeddingIntegrity(
        await inspectEmbeddingIntegrity(),
        'Cannot commit VECTOR repair metadata: repaired table',
        committedEmbeddingCount,
      );
      repairedMeta = {
        ...existingMeta,
        // A completed embedding checkpoint may pass the preflight (see
        // assertVectorRepairPreflight); a successful repair must not persist
        // the stale marker, or the next repair/resume re-enters recovery.
        embeddingCheckpoint: undefined,
        incrementalInProgress: undefined,
        repoPath: persistedRepoPath,
        remoteUrl: repositoryRemoteUrl ?? existingMeta.remoteUrl,
        stats: {
          ...existingMeta.stats,
          nodes: committedStats.nodes,
          edges: committedStats.edges,
          embeddings: committedEmbeddingCount,
        },
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: {
            provider: 'ladybugdb-fts',
            status: afterProbe.fts ? 'available' : 'unavailable',
          },
          vectorSearch: {
            provider: 'ladybugdb-vector',
            status: 'vector-index',
            exactScanLimit: runtimeCapabilities.exactScanLimit,
          },
        },
      };
      repairedMeta = preservePreAdoptionBranch(repairedMeta);
      await saveMeta(canonicalMetaDir, repairedMeta);
      projectName = await registerRepo(persistedRepoPath, repairedMeta, {
        name: options.registryName,
        allowDuplicateName: options.allowDuplicateName,
        ...frozenRegistryIdentity,
      });
    } finally {
      await closeLbug().catch(() => {});
    }
    progress('done', 100, 'VECTOR index verified through all eight pooled connections.');
    return {
      repoName: projectName,
      repoPath,
      stats: repairedMeta.stats ?? {},
      vectorRepairStatus: repairStatus,
    };
  }

  const promoteValidatedStage = async (paths: StagedAnalyzePaths): Promise<string | undefined> => {
    const stagedMeta = await validateStagedGeneration(paths);
    let stagedValidation: {
      stats: Awaited<ReturnType<typeof getLbugStats>>;
      integrity: EmbeddingIntegrityReport;
    };
    try {
      stagedValidation = await withLbugDb(
        paths.stagedLbugPath,
        async () => ({ stats: await getLbugStats(), integrity: await inspectEmbeddingIntegrity() }),
        { readOnly: true },
      );
    } finally {
      // Promotion renames this file. Windows refuses the rename while the
      // singleton read-only handle remains open.
      await closeLbug().catch(() => {});
    }
    const stagedStats = stagedValidation.stats;
    if (
      (stagedMeta.stats?.nodes !== undefined && stagedMeta.stats.nodes !== stagedStats.nodes) ||
      (stagedMeta.stats?.edges !== undefined && stagedMeta.stats.edges !== stagedStats.edges)
    ) {
      throw new Error(
        `Staged DB validation failed: metadata records ` +
          `${stagedMeta.stats?.nodes ?? '?'} nodes/${stagedMeta.stats?.edges ?? '?'} edges, ` +
          `but the readable DB contains ${stagedStats.nodes} nodes/${stagedStats.edges} edges.`,
      );
    }
    assertEmbeddingIntegrity(
      stagedValidation.integrity,
      'Staged DB validation',
      stagedMeta.stats?.embeddings,
    );
    return (
      await promoteStagedGeneration(paths, (meta) => commitStagedMetadataAndRegistry(meta, true), {
        readRepositoryIdentity,
      })
    ).projectName;
  };

  const validatePendingPromotionEmbeddingCandidate = async (
    paths: StagedAnalyzePaths,
  ): Promise<void> => {
    const stagedState = await lstatIfPresent(paths.stagedLbugPath);
    const candidatePath = stagedState?.isFile() ? paths.stagedLbugPath : paths.canonicalLbugPath;
    const candidateState = await lstatIfPresent(candidatePath);
    if (!candidateState?.isFile() || candidateState.isSymbolicLink()) {
      throw new Error(
        'Pending staged promotion has no unambiguous regular candidate database; refusing recovery.',
      );
    }
    const stagedRootState = await lstatIfPresent(paths.stageRoot);
    const candidateMeta = await loadMeta(
      stagedRootState ? paths.stagedMetaDir : paths.canonicalMetaDir,
    );
    if (!candidateMeta) {
      throw new Error('Pending staged promotion has no readable candidate metadata.');
    }
    try {
      const integrity = await withLbugDb(candidatePath, inspectEmbeddingIntegrity, {
        readOnly: true,
      });
      assertEmbeddingIntegrity(
        integrity,
        'Pending staged promotion candidate',
        candidateMeta.stats?.embeddings,
      );
    } finally {
      await closeLbug().catch(() => {});
    }
  };

  // Every analyze mode owns the same canonical slot and must resolve its
  // promotion journal before any fast path can report success. In particular,
  // a crash at old-backed-up may leave the canonical pathname temporarily
  // absent even when metadata still looks current.
  if (await hasPendingPromotion(promotionPaths)) {
    if (options.incrementalOnly) {
      throw new Error(
        'Incremental-only safety stop: a staged-promotion journal requires recovery before this index can be read as current. No recovery mutation was started.',
      );
    }
    progress('lbug', 1, 'Recovering staged promotion...');
    await validatePendingPromotionEmbeddingCandidate(promotionPaths);
    const recoveredPromotion = await promoteStagedGeneration(
      promotionPaths,
      (meta) => commitStagedMetadataAndRegistry(meta, true),
      {
        readRepositoryIdentity,
      },
    );
    log('Recovered and completed the previous staged promotion.');
    let recoveredMeta = await loadMeta(canonicalMetaDir);
    if (!recoveredMeta) {
      throw new Error('Recovered staged promotion is missing canonical metadata.');
    }
    if (implicitFlatBranch) {
      try {
        recoveredMeta = await adoptAndRestampImplicitFlatBranch(recoveredMeta);
      } catch (error) {
        log(
          `Warning: could not sync the recovered workspace branch label ` +
            `(${(error as Error).message}); will retry on the next run.`,
        );
      }
    }
    const recoveredRepoName =
      recoveredPromotion.projectName ??
      options.registryName ??
      getInferredRepoName(repoPath) ??
      path.basename(resolveRepoIdentityRoot(repoPath));

    // Recovery completes the same canonical promotion as the normal finalize
    // path, so finish its source-side bookkeeping before returning the explicit
    // recovery-only result. Context generation is best-effort, matching the
    // ordinary successful path.
    await ensureGitNexusIgnored(repoPath);
    if (!placement.branch) {
      try {
        await generateAIContextFiles(
          repoPath,
          storagePath,
          recoveredRepoName,
          {
            files: recoveredMeta.stats?.files,
            nodes: recoveredMeta.stats?.nodes,
            edges: recoveredMeta.stats?.edges,
            communities: recoveredMeta.stats?.communities,
            processes: recoveredMeta.stats?.processes,
          },
          undefined,
          {
            skipAgentsMd: options.skipAgentsMd,
            skipSkills: options.skipSkills,
            noStats: options.noStats,
            defaultBranch: options.defaultBranch,
            hasPdg: recoveredMeta.pdg !== undefined,
          },
        );
      } catch {
        // Best-effort — the recovered canonical index remains valid.
      }
    }
    progress('done', 100, 'Recovered staged promotion');
    return {
      repoName: recoveredRepoName,
      repoPath,
      stats: recoveredMeta.stats ?? {},
      recoveredPromotionOnly: true,
      isPrimaryBranch: !placement.branch,
    };
  }

  // Analyze indexes the working tree, not an arbitrary ref. A journal recovery
  // above is intentionally terminal: combining crash recovery with a second
  // source build recreates the ambiguous lifecycle that staged mode is meant to
  // avoid. The caller must start a fresh explicit analyze for the current tree.
  if (options.branch && checkedOutBranch && options.branch !== checkedOutBranch) {
    throw new Error(
      `--branch "${options.branch}" does not match the checked-out branch "${checkedOutBranch}". ` +
        `Check out "${options.branch}" before indexing it, or omit --branch to index the current branch.`,
    );
  }

  if (stagedPaths && options.repairFts) {
    throw new Error('`--staged` cannot be combined with `--repair-fts`; repair is in-place only.');
  }

  let stagedWorkspaceExisted = false;
  let canonicalDatabaseExistedAtStageStart = false;
  let canonicalMetaAtStageStart: RepoMeta | null = null;
  if (stagedPaths) {
    canonicalMetaAtStageStart = await loadMeta(canonicalMetaDir);
    const stagedSourceAtStart = await inspectStagedWorkspaceSource(
      stagedPaths,
      canonicalMetaAtStageStart,
      repositorySource,
    );
    const canonicalDatabaseStateAtStart = await lstatIfPresent(canonicalPaths.lbugPath);
    stagedWorkspaceExisted = stagedSourceAtStart.exists;
    canonicalDatabaseExistedAtStageStart = canonicalDatabaseStateAtStart !== null;

    if (stagedWorkspaceExisted && !options.dropEmbeddings) {
      throw new Error(
        'An unjournaled staged generation already exists. It was left untouched for forensics ' +
          'and will not be promoted or resumed automatically. Re-run with `--drop-embeddings` ' +
          'only when replacing that derived stage with a clean isolated generation is intentional.',
      );
    }
    if (
      !stagedWorkspaceExisted &&
      canonicalDatabaseExistedAtStageStart &&
      !options.dropEmbeddings
    ) {
      throw new Error(
        'Starting staged work from an existing canonical database requires explicit ' +
          '`--drop-embeddings`. The canonical index is unchanged. Semantic refreshes must use ' +
          '`--staged --embeddings --drop-embeddings`; graph-only rebuilds must use ' +
          '`--staged --drop-embeddings`.',
      );
    }
    const prepared = await prepareStagedWorkspace(
      stagedPaths,
      canonicalMetaAtStageStart,
      repositorySource,
    );
    log(
      prepared.resumed
        ? 'Resuming the existing staged generation; the canonical index remains untouched.'
        : 'Prepared an isolated staged generation; the canonical index remains readable.',
    );
  }

  const lbugPath = stagedPaths?.stagedLbugPath ?? canonicalPaths.lbugPath;
  const metaDir = stagedPaths?.stagedMetaDir ?? canonicalMetaDir;

  if (options.incrementalOnly && (options.force || options.repairFts)) {
    incrementalOnlyStop('it cannot be combined with --force or --repair-fts');
  }

  // Preservation preflight: load only. Do not reconcile metadata, clean old
  // stores, inspect via LadybugDB, or touch sidecars until every invariant
  // needed for a surgical incremental write is established.
  let existingMeta = await loadMeta(metaDir);
  if (stagedPaths) {
    // electric.4-.7 proved that restoring or resuming embedding rows inside a
    // staged copy is not a safe compatibility surface. Keep the useful part of
    // staged analyze (isolated full generation + validated promotion). Every
    // replacement of existing derived state is explicit and starts clean.
    if (options.dropEmbeddings || (options.embeddings && !existingMeta)) {
      // The target is the isolated staged DB. Forcing a full write wipes only
      // that disposable copy; the canonical generation stays readable until
      // the final integrity scan and journaled promotion both succeed.
      options = { ...options, force: true };
    }
  }
  if (options.incrementalOnly) {
    if (!existingMeta) {
      incrementalOnlyStop('no existing index metadata is available');
    }
    if (!repoHasGit) {
      incrementalOnlyStop('the repository has no Git history for incremental comparison');
    }
    if (existingMeta.incrementalInProgress) {
      incrementalOnlyStop('the existing index has an interrupted-analysis dirty marker');
    }
    if (pdgModeMismatch(existingMeta.pdg, options)) {
      incrementalOnlyStop('the requested PDG mode differs from the indexed mode');
    }
    if (existingMeta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
      incrementalOnlyStop(
        `the index schema is ${existingMeta.schemaVersion ?? 'pre-versioning'}, not ${INCREMENTAL_SCHEMA_VERSION}`,
      );
    }
    if (cjkSegmentationModeMismatch(existingMeta.cjkSegmentation, getSearchFTSCjkSegmentation())) {
      incrementalOnlyStop('the requested CJK segmentation mode differs from the indexed mode');
    }
    if (!existingMeta.fileHashes || Object.keys(existingMeta.fileHashes).length === 0) {
      incrementalOnlyStop('the existing metadata has no file-hash baseline');
    }
    if (!placement.branch && branchLabel && existingMeta.branch !== branchLabel) {
      incrementalOnlyStop('the flat index branch label requires a metadata restamp');
    }
    try {
      const graphStat = await fs.lstat(lbugPath);
      if (!graphStat.isFile()) {
        incrementalOnlyStop('the graph store is not a regular file');
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Incremental-only safety stop:')) {
        throw err;
      }
      incrementalOnlyStop('the graph store is missing or inaccessible');
    }
    for (const sidecarPath of [
      `${lbugPath}.wal`,
      `${lbugPath}.shadow`,
      `${lbugPath}.wal.checkpoint`,
    ]) {
      try {
        await fs.lstat(sidecarPath);
        incrementalOnlyStop('LadybugDB sidecar state requires recovery');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Incremental-only safety stop:')) {
          throw err;
        }
        if (!isMissingFilesystemError(err)) {
          incrementalOnlyStop('LadybugDB sidecar state is inaccessible');
        }
      }
    }
  } else {
    // Normal analyze retains its established self-healing behavior.
    const kuzuResult = options.staged
      ? { found: false, needsReindex: false }
      : await cleanupOldKuzuFiles(storagePath);
    if (kuzuResult.found && kuzuResult.needsReindex) {
      log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
    }

    // Keep gitnexus.json and the legacy meta.json mirror in sync (fresher
    // indexedAt wins; nothing is deleted). Best-effort: loadMeta has its own
    // legacy fallback, so a reconciliation failure (read-only mount, full disk)
    // must never abort the analyze run — a repo that indexed fine read-only
    // before the rename must keep doing so.
    if (!options.staged) {
      try {
        await reconcileMetadataFiles(repoPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        log(`Metadata reconciliation failed (non-critical${code ? `, ${code}` : ''}); continuing.`);
      }
    }
    existingMeta = await loadMeta(metaDir);
  }

  // ── FTS-only repair path ────────────────────────────────────────────
  if (options.repairFts) {
    if (!existingMeta) {
      throw new Error(
        'Cannot repair FTS indexes because this repository has not been analyzed yet. ' +
          'Run `gitnexus analyze` first to create the initial index, then retry `--repair-fts`.',
      );
    }
    if (existingMeta.incrementalInProgress) {
      // #2409 / tri-review 4669518496 (R6): a dirty flag means the previous
      // run died mid-writeback — the graph may be half-written and its WAL
      // possibly poisoned. This branch returns early, so the dirty-recovery
      // sidecar quarantine below would never run: repairing FTS now would
      // open the DB and replay that WAL pre-quarantine, and even a
      // survivable open would certify FTS over a half-written graph.
      throw new Error(
        'Cannot repair FTS indexes: the index is mid-incremental-recovery ' +
          '(a previous analyze run did not complete cleanly). ' +
          'Run `gitnexus analyze` first — it recovers the index automatically — ' +
          'then retry `--repair-fts`.',
      );
    }
    let lbugStat;
    try {
      lbugStat = await fs.lstat(lbugPath);
    } catch {
      throw new Error(
        `Cannot repair FTS indexes: graph store at ${lbugPath} is missing. ` +
          'Run `gitnexus analyze` (full) to rebuild from scratch.',
      );
    }
    if (!lbugStat.isFile()) {
      const foundType = lbugStat.isDirectory()
        ? 'a directory'
        : lbugStat.isSymbolicLink()
          ? 'a symbolic link'
          : lbugStat.isSocket()
            ? 'a socket'
            : lbugStat.isBlockDevice()
              ? 'a block device'
              : lbugStat.isCharacterDevice()
                ? 'a character device'
                : lbugStat.isFIFO()
                  ? 'a FIFO'
                  : 'not a regular file';
      throw new Error(
        `Cannot repair FTS indexes: graph store at ${lbugPath} is ${foundType} (expected a file). ` +
          'Run `gitnexus analyze` (full) to rebuild from scratch.',
      );
    }
    try {
      await initLbug(lbugPath);
      // Gate on FTS availability BEFORE touching any index. createSearchFTSIndexes
      // now DROPs each index before recreating it (so schema changes reach existing
      // DBs); if the extension were unavailable, the drops would run and leave the
      // DB index-less, only failing at the create step. Fail loudly first — mirrors
      // the analyze path's `if (ftsAvailable)` gate below — so an unavailable
      // extension never destroys the existing indexes.
      const repairFtsAvailable = await loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (!repairFtsAvailable) {
        // Surface the load-side reason (#2374): "not pre-installed" was wrong
        // and doctor never installed anything, so the old message trapped
        // users in a query → repair-fts → doctor loop with no way out.
        const rawFtsReason = getExtensionCapabilities().find((c) => c.name === 'fts')?.reason;
        const ftsReason = rawFtsReason?.replace(/\.$/, '');
        // A missing runtime dependency (Windows error 126, #2374) is not healed
        // by re-installing — the file is already present. Route that class to the
        // classified remedy (install VC++ redist / OpenSSL) instead of the old
        // "retry the network install" text that trapped the user in a loop.
        const { kind, remedy } = diagnoseExtensionLoad(rawFtsReason);
        const remedyTail =
          kind === 'missing_dependency'
            ? ` ${remedy}`
            : '. Retry with network access and GITNEXUS_LBUG_EXTENSION_INSTALL=auto to install it, ' +
              'or pre-install the extension file; run `gitnexus doctor` for live FTS status.';
        throw new Error(
          'Cannot repair FTS indexes: the LadybugDB FTS extension failed to load' +
            (ftsReason ? ` — ${ftsReason}` : '') +
            remedyTail,
        );
      }
      progress('fts', 85, 'Repairing search indexes...');
      await createSearchFTSIndexes({
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const missing = await verifySearchFTSIndexes(executeQuery);
      if (missing.length > 0) {
        throw new Error(
          `FTS repair failed - missing indexes after rebuild: ${missing.join(', ')}. ` +
            'Run `gitnexus analyze --force` to perform a full graph+FTS rebuild; ' +
            'if that also fails, verify FTS extension availability via `gitnexus doctor`.',
        );
      }
      await ensureGitNexusIgnored(repoPath);
      progress('fts', 90, 'Search indexes ready');
      progress('done', 100, 'Done');
      return {
        repoName:
          options.registryName ??
          getInferredRepoName(repoPath) ??
          path.basename(resolveRepoIdentityRoot(repoPath)),
        repoPath,
        stats: existingMeta.stats ?? {},
        ftsRepairedOnly: true,
      };
    } finally {
      await closeLbug().catch(() => {});
    }
  }

  let resumeEmbeddingCheckpoint = false;
  let pendingEmbeddingNodeIds = new Set<string>();
  let embeddingIdentityForRun: EmbeddingIdentity | undefined;
  const isEmptyLegacyCheckpoint = (checkpoint: NonNullable<RepoMeta['embeddingCheckpoint']>) =>
    checkpoint.provider === undefined &&
    checkpoint.nodesProcessed === 0 &&
    checkpoint.totalNodes === 0 &&
    !checkpoint.pendingNodeIds?.length;
  if (existingMeta?.embeddingCheckpoint) {
    if (options.dropEmbeddings) {
      log('Discarding the interrupted embedding checkpoint (--drop-embeddings).');
      options = { ...options, force: true };
    } else if (!isEmptyLegacyCheckpoint(existingMeta.embeddingCheckpoint)) {
      embeddingIdentityForRun = await resolveEmbeddingIdentity();
      const checkpoint = existingMeta.embeddingCheckpoint;
      if (
        checkpoint.provider === undefined ||
        checkpoint.provider !== embeddingIdentityForRun.provider ||
        checkpoint.model !== embeddingIdentityForRun.model ||
        checkpoint.dimensions !== embeddingIdentityForRun.dimensions
      ) {
        throw new Error(
          `Cannot resume embedding checkpoint: it uses ${checkpoint.provider ?? 'unknown-provider'} / ` +
            `${checkpoint.model} at ${checkpoint.dimensions} dimensions, but this run resolves ` +
            `${embeddingIdentityForRun.provider} / ${embeddingIdentityForRun.model} at ` +
            `${embeddingIdentityForRun.dimensions}. ` +
            'Restore the matching embedding configuration or pass --drop-embeddings --embeddings 0 to rebuild without it.',
        );
      }
      resumeEmbeddingCheckpoint = true;
      pendingEmbeddingNodeIds = new Set(checkpoint.pendingNodeIds ?? []);
      log(
        `Previous analyze ended at an embedding checkpoint ` +
          `(${checkpoint.nodesProcessed}/${checkpoint.totalNodes} nodes); resuming from persisted hashes` +
          `${pendingEmbeddingNodeIds.size > 0 ? ` and regenerating ${pendingEmbeddingNodeIds.size} pending node(s)` : ''}.`,
      );
    }
  }

  // ── Crash recovery: dirty flag forces full rebuild ────────────────
  // If the previous incremental run set incrementalInProgress and didn't
  // clear it, the on-disk index may be in a half-state. Cheapest path
  // back to a known-good index is to wipe + rebuild from scratch.
  if (existingMeta?.incrementalInProgress) {
    if (options.incrementalOnly) {
      incrementalOnlyStop('the existing index has an interrupted-analysis dirty marker');
    }
    const dirty = existingMeta.incrementalInProgress;
    const dirtyDetails =
      typeof dirty === 'object'
        ? [
            dirty.phase ? `phase=${dirty.phase}` : undefined,
            `toWrite=${dirty.toWriteCount}`,
            dirty.importerExpansion !== undefined
              ? `importerExpansion=${dirty.importerExpansion}`
              : undefined,
            dirty.effectiveWriteCount !== undefined
              ? `effectiveWrite=${dirty.effectiveWriteCount}`
              : undefined,
            dirty.deleteCount !== undefined ? `deleteCount=${dirty.deleteCount}` : undefined,
            // Only stamped when > 0 (tri-review 4669518496 P2-5): its
            // presence means the crashed run's importer expansion was
            // already degraded — the write set may have been under-expanded
            // before the crash.
            dirty.droppedImporterChunks !== undefined
              ? `droppedImporterChunks=${dirty.droppedImporterChunks}`
              : undefined,
          ]
            .filter(Boolean)
            .join(', ')
        : 'legacy dirty flag';
    log(
      // "analyze run", not "incremental run" — since #2099 F1 the flag is a
      // generic dirty marker written by BOTH writeback branches.
      'Previous analyze run did not complete cleanly (incrementalInProgress flag set); ' +
        `last dirty state: ${dirtyDetails}; ` +
        'forcing full rebuild to restore a known-good index.',
    );
    options = { ...options, force: true };
    // Reload meta after clearing the flag in-memory; we still want fileHashes
    // for the post-rebuild meta carry-over, but force=true ensures the
    // rebuild path executes.
    //
    // #2409 defect 2: the crashed writeback's WAL can be poisoned — replaying
    // it kills the process natively, and the first DB open of this recovery
    // run (the embedding-cache preservation open below) happens BEFORE the
    // rebuild wipe that would discard it. Park the WAL/shadow sidecars aside
    // now, while nothing is open, so every open in this run is replay-free.
    // The rebuild wipes the DB regardless, so no committed data is at stake.
    const { removed, failed } = await quarantineSidecarsForDirtyRecovery(lbugPath, log);
    if (removed.length > 0) {
      log(
        `Dirty-state recovery discarded ${removed.map((p) => path.basename(p)).join(', ')} ` +
          'from the interrupted run (the file could not be moved aside, so its bytes were ' +
          'removed — post-mortem forensics lost). Recovery proceeds with full embedding ' +
          'preservation.',
      );
    }
    if (failed.length > 0) {
      // FIX 1 (this shipping review, replacing the tri-review 4669518496
      // P2-3 drop-shape design): under a persistent lock the old drop-shape
      // run derived its embedding mode as "drop", ran the WHOLE pipeline,
      // and then died at the rebuild wipe on the very same handle — wasting
      // minutes and zeroing embeddings on the way. A possibly-poisoned
      // sidecar still sits next to the DB (any pre-wipe open would replay it
      // and die), so failing here, in seconds, with the same actionable
      // typed error the wipe would eventually throw is strictly better —
      // and the CLI's LbugWipeError handler already renders it
      // (recoveryHint 'lbug-wipe-failed'). The message is self-contained
      // (headline + paths + lock guidance) because serve forwards only
      // err.message over worker IPC.
      throw new LbugWipeError(failed, {
        headline:
          "Cannot start dirty-state recovery — the interrupted run's LadybugDB sidecars " +
          'could neither be moved aside nor removed:',
      });
    }
  }

  const legacyCheckpoint = existingMeta?.embeddingCheckpoint;
  if (!options.dropEmbeddings && legacyCheckpoint && isEmptyLegacyCheckpoint(legacyCheckpoint)) {
    const integrity = await withLbugDb(lbugPath, inspectEmbeddingIntegrity, {
      readOnly: true,
    }).finally(() => closeLbug());
    if (integrity.physicalRows > 0) {
      throw new Error(
        'Cannot resume embedding checkpoint: it uses unknown-provider while the table contains ' +
          'rows. Restore the matching embedding configuration or pass --drop-embeddings --embeddings 0 to rebuild without it.',
      );
    }
    assertCompletedCheckpointIdentity(legacyCheckpoint, integrity, CLI_CHECKPOINT_CONTEXT);
    existingMeta = {
      ...existingMeta,
      stats: { ...existingMeta.stats, embeddings: 0 },
      embeddingCheckpoint: undefined,
    };
    if (stagedPaths || !(await isRepoRegistered(repoPath))) {
      await savePreAdoptionMeta(metaDir, existingMeta);
    } else {
      await commitStagedMetadataAndRegistry(existingMeta);
    }
  }

  // Checkpoint windows are durable boundaries even before the final window.
  // Validate any completed (no-pending) window that carries identity proof,
  // but only after dirty-recovery sidecars have been quarantined: opening the
  // database before that point can replay a poisoned interrupted WAL.
  const checkpointToVerify = existingMeta?.embeddingCheckpoint;
  if (
    resumeEmbeddingCheckpoint &&
    checkpointToVerify &&
    !checkpointToVerify.pendingNodeIds?.length &&
    [
      checkpointToVerify.physicalRows,
      checkpointToVerify.validRows,
      checkpointToVerify.recoverableIdentitySha256,
    ].some((value) => value !== undefined)
  ) {
    try {
      const completedIntegrity = await withLbugDb(lbugPath, inspectEmbeddingIntegrity, {
        readOnly: true,
      });
      assertCompletedCheckpointIdentity(
        checkpointToVerify,
        completedIntegrity,
        'Completed embedding checkpoint',
      );
    } finally {
      await closeLbug();
    }
  }

  // ── pdg-mode flip forces full writeback (#2099 F1) ─────────────────
  // The incremental writeback persists only changed-file nodes, so a pdg
  // config differing from the one the DB rows were built under cannot be
  // reconciled incrementally: off→on silently drops the freshly built CFG
  // layer ("Incremental: changed=0", zero BasicBlock rows), on→off strands
  // zombie blocks for unchanged files. MUST sit before the alreadyUpToDate
  // fast path below — a clean-tree flip would otherwise early-return without
  // running the pipeline at all. The notice is deliberately NOT gated on
  // options.force: --skills implies force with no message of its own, and a
  // mode change deserves a diagnostic regardless of why a rebuild happens.
  if (existingMeta && pdgModeMismatch(existingMeta.pdg, options)) {
    if (options.incrementalOnly) {
      incrementalOnlyStop('the requested PDG mode differs from the indexed mode');
    }
    const pdgOn = options.pdg === true;
    const capsOnly = !!existingMeta.pdg && pdgOn; // both-on can only mismatch via caps
    const was = existingMeta.pdg ? 'with --pdg' : 'without --pdg';
    const now = pdgOn ? 'with --pdg' : 'without --pdg';
    log(
      `pdg mode changed (index built ${was}, this run is ${now}` +
        `${capsOnly ? ', but with different caps' : ''}); forcing a full ` +
        `rebuild so the CFG layer is ${pdgOn ? 'fully persisted' : 'fully removed'}. ` +
        `Tip: set \`pdg: ${pdgOn}\` in .gitnexusrc to pin the mode across runs.`,
    );
    options = { ...options, force: true };
  }

  // ── schema-version mismatch forces full rebuild (#2289 P1) ────────
  // Mirrors the pdg-mode block above: a stamp from an older
  // INCREMENTAL_SCHEMA_VERSION (e.g. pre-v5 URL-only Route ids) cannot be
  // reconciled by an incremental top-up — same-commit re-analyze would
  // strand stale rows next to new-schema writes. MUST sit before the
  // alreadyUpToDate fast path below: an unchanged-commit clean tree would
  // otherwise early-return without ever reaching the `isIncremental` gate
  // that consults `schemaVersion`, defeating the bump's whole point.
  //
  // `schemaVersion === undefined` now means legacy metadata from before the
  // field existed. New indexes always stamp their schema identity, including
  // non-Git and `--skip-git` repositories, because staged embedding recovery
  // must not misclassify a current checkpoint as pre-versioning.
  if (existingMeta && existingMeta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
    if (options.incrementalOnly) {
      incrementalOnlyStop('the index schema requires a full rebuild');
    }
    const stampedVersion = existingMeta.schemaVersion ?? 'pre-versioning';
    log(
      `index schema changed (stamped v${stampedVersion}, this build is v${INCREMENTAL_SCHEMA_VERSION}); ` +
        `forcing a full rebuild so persisted rows match the current schema.`,
    );
    options = { ...options, force: true };
  }

  if (
    existingMeta &&
    cjkSegmentationModeMismatch(existingMeta.cjkSegmentation, getSearchFTSCjkSegmentation())
  ) {
    if (options.incrementalOnly) {
      incrementalOnlyStop('the requested CJK segmentation mode differs from the indexed mode');
    }
    log(
      `CJK segmentation mode changed (index built with '${existingMeta.cjkSegmentation ?? 'none'}', ` +
        `this run resolves '${getSearchFTSCjkSegmentation()}'); forcing a full rebuild so indexed ` +
        `text and query-time segmentation stay in sync.`,
    );
    options = { ...options, force: true };
  }

  // ── Early-return: already up to date ──────────────────────────────
  if (
    existingMeta &&
    !existingMeta.embeddingCheckpoint &&
    !options.force &&
    existingMeta.lastCommit === currentCommit
  ) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      // For git repos, even if HEAD matches lastCommit, the working tree
      // may have uncommitted changes. Only short-circuit when the working
      // tree is also clean — otherwise fall through to the incremental
      // path which will hash-diff and update only changed files.
      //
      // We exclude paths that GitNexus itself writes during analyze:
      //   .gitnexus/                  — db / parse cache / meta.json
      //   .claude/, .cursor/          — auto-generated agent skill files
      //   AGENTS.md, CLAUDE.md        — auto-updated stats blocks
      // Counting them as dirty would perpetually defeat the up-to-date
      // fast path because the previous analyze just wrote them
      // (regression vs PR #1233 behavior).
      const dirty = (() => {
        try {
          const out = execFileSync(
            'git',
            [
              'status',
              '--porcelain',
              '--',
              '.',
              ':(exclude).gitnexus',
              ':(exclude).gitnexus/**',
              ':(exclude).claude',
              ':(exclude).claude/**',
              ':(exclude).cursor',
              ':(exclude).cursor/**',
              ':(exclude)AGENTS.md',
              ':(exclude)CLAUDE.md',
            ],
            {
              cwd: repoPath,
              stdio: ['ignore', 'pipe', 'ignore'],
              windowsHide: true,
              encoding: 'utf8',
            },
          );
          return out.trim().length > 0;
        } catch {
          return true; // conservative on git failure
        }
      })();
      // Registration wrinkle around the fast path (#2264). A prior
      // `analyze --name X` that hit a name collision writes meta.json (meta-save
      // runs before registerRepo) then fails before registering, leaving the
      // index up-to-date but UNREGISTERED. When the user re-runs with
      // --allow-duplicate-name they explicitly want it registered, so fall
      // through to the pipeline (which registers it, honoring the flag) instead
      // of early-returning an unregistered repo the flag could never heal.
      // For a PLAIN analyze we deliberately do NOT self-heal: an up-to-date but
      // unregistered repo early-returns here and the CLI's assertAnalysisFinalized
      // surfaces it as a hard failure (#1169) rather than silently registering a
      // possibly half-finalized index. `isRepoRegistered` is only read on the
      // opt-in branch so the common fast path keeps its single-stat cost.
      const healUnregistered =
        options.allowDuplicateName === true && !(await isRepoRegistered(repoPath));
      if (!dirty && !healUnregistered) {
        const recordedEmbeddingCount = existingMeta.stats?.embeddings;
        let fastPathIntegrity: EmbeddingIntegrityReport;
        try {
          fastPathIntegrity = await withLbugDb(canonicalPaths.lbugPath, inspectEmbeddingIntegrity, {
            readOnly: true,
          });
          assertEmbeddingIntegrity(fastPathIntegrity, 'Already-up-to-date index');
        } finally {
          // This return precedes the main pipeline's close-protected block.
          // This path is read-only, so it does not carry the large-write
          // destructor risk that requires closeLbugBeforeExit elsewhere.
          // Close for real so the next process never inherits shadow pages
          // that a read-only query cannot replay.
          await closeLbug();
        }
        if ((recordedEmbeddingCount ?? 0) > 0 && fastPathIntegrity.validRows === 0) {
          throw new Error(
            'Already-up-to-date index lost all recorded embeddings; re-run analyze --embeddings 0.',
          );
        }
        let fastPathMeta = existingMeta;
        if (
          fastPathIntegrity.validRows > 0 &&
          recordedEmbeddingCount !== fastPathIntegrity.validRows
        ) {
          if (options.incrementalOnly) {
            incrementalOnlyStop('the verified embedding count requires a metadata restamp');
          }
          fastPathMeta = {
            ...existingMeta,
            stats: { ...existingMeta.stats, embeddings: fastPathIntegrity.validRows },
          };
          try {
            await savePreAdoptionMeta(metaDir, fastPathMeta);
          } catch (err) {
            if (!isReadOnlyFilesystemError(err)) throw err;
            log(
              `Warning: could not restamp the verified embedding count ` +
                `(${(err as Error).message} — storage may be read-only (#1549)); ` +
                'using the verified live count for this read-only run.',
            );
          }
        }
        // ── #2354: restamp the workspace label on a same-commit branch flip ──
        // The flat slot follows the checked-out working tree; a branch switch
        // at the SAME commit with a clean tree changes nothing the pipeline
        // must rebuild, but the slot's informational `branch` label (and the
        // registry copy that query-side branch scoping reads) would go stale.
        // Detached HEAD / non-git (branchLabel === null) keeps the existing
        // stamp, mirroring the end-of-run meta write.
        if (
          !stagedPaths &&
          implicitFlatBranch &&
          (!options.incrementalOnly || existingMeta.branch !== implicitFlatBranch)
        ) {
          if (options.incrementalOnly) {
            incrementalOnlyStop('the flat index branch label requires a metadata restamp');
          }
          // Adopt first, stamp last (#2364 review F3): this block's retry
          // guard is `existingMeta.branch !== branchLabel`, so stamping the
          // meta before the registry/shadow cleanup would flip the guard and
          // lock in any partial failure — with saveMeta last, a failed adopt
          // leaves the guard true and the next same-commit run self-heals
          // (adopt is idempotent). The whole sync is best-effort: the label
          // is informational and the flat DB content is byte-valid for both
          // labels here (same commit, clean tree), so an "Already up to
          // date" run must not fail over it; read-only storage — the
          // documented Docker :ro workflow (#1549) — degrades to a warning.
          try {
            fastPathMeta = await adoptAndRestampImplicitFlatBranch(fastPathMeta);
          } catch (err) {
            // EACCES/EPERM also arise from ownership problems and transient
            // Windows locks, so keep the real error visible alongside the
            // #1549 read-only hint instead of replacing it.
            const reason = isReadOnlyFilesystemError(err)
              ? `${(err as Error).message} — storage may be read-only (#1549)`
              : (err as Error).message;
            log(
              `Warning: could not restamp the workspace branch label (${reason}); will retry on the next run.`,
            );
          }
        }
        if (stagedPaths) {
          await discardStagedWorkspace(stagedPaths);
        } else if (!options.incrementalOnly) {
          await ensureGitNexusIgnored(repoPath);
        }
        return {
          // `resolveRepoIdentityRoot` collapses worktree roots to the
          // canonical repo basename (#1259) but leaves arbitrary subdirs
          // and `--skip-git` paths unchanged (#1232/#1233 intent preserved).
          repoName:
            options.registryName ??
            getInferredRepoName(repoPath) ??
            path.basename(resolveRepoIdentityRoot(repoPath)),
          repoPath,
          stats: fastPathMeta.stats ?? {},
          alreadyUpToDate: true,
          isPrimaryBranch: !placement.branch,
        };
      }
    }
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  // Four modes:
  //   --embeddings              -> load cache, restore, then generate any new ones
  //   --force (with existing
  //    embeddings)              -> auto-imply --embeddings: load cache, restore,
  //                                regenerate embeddings for new/changed nodes
  //                                (a forced re-index of an embedded repo
  //                                shouldn't quietly downgrade to "preserve only")
  //   (default)                 -> if existing index has embeddings, preserve them
  //                                (load + restore, but do not generate); otherwise no-op
  //   --drop-embeddings         -> skip cache load entirely; rebuild wipes embeddings
  //
  // The default-preserve branch is what makes a routine `analyze` (e.g. a
  // post-commit hook) safe: a multi-minute embedding pass is no longer
  // silently dropped just because the caller omitted `--embeddings`.
  const embeddingSnapshotPath = path.join(metaDir, EMBEDDING_SNAPSHOT_FILE);
  const embeddingTableRebuildMarkerPath = path.join(metaDir, 'embedding-table-rebuild.json');
  const embeddingSnapshotSource = {
    lastCommit: existingMeta?.lastCommit,
    indexedAt: resumeEmbeddingCheckpoint ? undefined : existingMeta?.indexedAt,
  };
  const embeddingSnapshotValidationOptions =
    stagedPaths && resumeEmbeddingCheckpoint
      ? { allowSourceIndexedAtDriftForCheckpointResume: true as const }
      : undefined;
  let embeddingSnapshotInfo: EmbeddingSnapshotInfo | undefined;
  let embeddingSnapshotAvailable = false;
  let embeddingTableRebuildStarted = false;
  let rebuildStagedEmbeddingTableForResume =
    Boolean(stagedPaths) && resumeEmbeddingCheckpoint && pendingEmbeddingNodeIds.size > 0;

  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const {
    forceRegenerateEmbeddings,
    preserveExistingEmbeddings,
    shouldGenerateEmbeddings: derivedShouldGenerateEmbeddings,
    shouldLoadCache: derivedShouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);
  const shouldGenerateEmbeddings = derivedShouldGenerateEmbeddings || resumeEmbeddingCheckpoint;
  const shouldLoadCache = derivedShouldLoadCache || resumeEmbeddingCheckpoint;

  if (options.dropEmbeddings && existingEmbeddingCount > 0) {
    log(
      `Dropping ${existingEmbeddingCount} existing embeddings (--drop-embeddings). ` +
        `Re-run with --embeddings 0 to regenerate.`,
    );
  } else if (forceRegenerateEmbeddings) {
    log(
      `--force on a repo with ${existingEmbeddingCount} existing embeddings: ` +
        `regenerating embeddings for new/changed nodes. ` +
        `Pass --drop-embeddings to wipe them instead.`,
    );
  } else if (preserveExistingEmbeddings) {
    log(
      `Preserving ${existingEmbeddingCount} existing embeddings. ` +
        `Pass --embeddings to also generate embeddings for new/changed nodes, ` +
        `or --drop-embeddings to wipe them.`,
    );
  }

  // We *always* load the embedding cache when one is requested (regardless
  // of the predicted `willTryIncremental`). The post-pipeline branch may
  // disagree with the prediction (e.g. when the pipeline produces zero
  // File nodes, `isIncremental` flips false and the full-rebuild path
  // wipes the DB) — loading unconditionally is cheap insurance against
  // silently dropping embeddings on a mispredicted run. The re-insert
  // step gates itself on the actual `isIncremental` value to avoid
  // PK-conflicts when the incremental writeback path keeps the rows.
  //
  // This is the FIRST DB open of the run — the one #2409 defect 2 is about.
  // On a dirty-recovery run it happens only after the sidecar quarantine
  // moved (or removed) the crashed run's WAL/shadow; when neither was
  // possible the dirty block above already threw a LbugWipeError, so this
  // open is replay-free by construction (FIX 1 of this shipping review).
  if (shouldLoadCache && existingMeta) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      const expectedSnapshotCount = resumeEmbeddingCheckpoint ? undefined : existingEmbeddingCount;
      embeddingSnapshotInfo = await validateEmbeddingSnapshot(
        embeddingSnapshotPath,
        embeddingSnapshotSource,
        expectedSnapshotCount,
        embeddingSnapshotValidationOptions,
      );
      if (stagedPaths && resumeEmbeddingCheckpoint) {
        embeddingTableRebuildStarted = await validateEmbeddingTableRebuildMarker(
          embeddingTableRebuildMarkerPath,
          embeddingSnapshotSource,
          embeddingSnapshotInfo,
        );
        if (embeddingTableRebuildStarted) rebuildStagedEmbeddingTableForResume = true;
        // Once a matching marker exists, the validated snapshot is the only
        // authority: the table may already be empty or partially restored.
        // Before the first destructive rebuild, prefer a clean live table so a
        // checkpoint row written after an older snapshot is not lost. A known
        // malformed native table is recoverable only when the pre-existing,
        // checksummed snapshot covers every unique live-owner identity and has
        // no duplicates. That is the narrow ClawSweeper recovery seam.
        if (!embeddingTableRebuildStarted && embeddingSnapshotInfo) {
          const sourceIntegrity = await withLbugDb(lbugPath, inspectEmbeddingIntegrity, {
            readOnly: true,
          });
          if (embeddingIntegrityIsClean(sourceIntegrity)) {
            embeddingSnapshotInfo = undefined;
          } else {
            const snapshotAuthorizesRecovery =
              (embeddingSnapshotInfo.duplicateRows ?? 0) === 0 &&
              embeddingSnapshotInfo.count === sourceIntegrity.recoverableRows &&
              embeddingSnapshotMatchesIdentityDigest(
                embeddingSnapshotInfo,
                sourceIntegrity.recoverableIdentitySha256,
              ) &&
              sourceIntegrity.orphanRows === 0 &&
              sourceIntegrity.invalidChunkRows === 0 &&
              sourceIntegrity.wrongDimensionRows === 0;
            if (!snapshotAuthorizesRecovery) {
              throw new Error(
                `Interrupted staged table is malformed and its preservation snapshot ` +
                  `does not cover every recoverable identity (${embeddingIntegritySummary(sourceIntegrity)}).`,
              );
            }
            rebuildStagedEmbeddingTableForResume = true;
            log(
              `The interrupted staged embedding table is malformed; its validated ` +
                `${embeddingSnapshotInfo.count}-row preservation snapshot will be made ` +
                `authoritative before isolated recreation.`,
            );
          }
        }
      }
      if (embeddingSnapshotInfo) {
        embeddingSnapshotAvailable = true;
        log(
          `Reusing validated embedding preservation snapshot ` +
            `(${embeddingSnapshotInfo.count} vectors).`,
        );
      } else {
        if (rebuildStagedEmbeddingTableForResume) {
          log('Refreshing the staged embedding snapshot before checkpoint resume.');
        }
        if (stagedPaths && resumeEmbeddingCheckpoint) {
          const sourceIntegrity = await withLbugDb(lbugPath, inspectEmbeddingIntegrity, {
            readOnly: true,
          });
          assertEmbeddingIntegrity(sourceIntegrity, 'Embedding preservation source');
        }
        embeddingSnapshotInfo = await createEmbeddingSnapshot(
          embeddingSnapshotPath,
          embeddingSnapshotSource,
          async (emit) => {
            const load = async () =>
              loadCachedEmbeddings({
                batchSize: EMBEDDING_PRESERVATION_BATCH_SIZE,
                onBatch: emit,
              });
            const cached = options.incrementalOnly
              ? await withLbugDb(lbugPath, load, { readOnly: true })
              : await (async () => {
                  await initLbug(lbugPath);
                  return load();
                })();
            // Legacy unit doubles return a small array and ignore onBatch. The
            // snapshot writer consumes that return without weakening production's
            // streaming path.
            return cached.embeddings;
          },
        );
        embeddingSnapshotAvailable = true;
        await closeLbug();
      }
      if (rebuildStagedEmbeddingTableForResume && !embeddingTableRebuildStarted) {
        await writeEmbeddingTableRebuildMarker(
          embeddingTableRebuildMarkerPath,
          embeddingSnapshotSource,
          embeddingSnapshotInfo,
        );
        embeddingTableRebuildStarted = true;
      }
      if (
        !resumeEmbeddingCheckpoint &&
        existingEmbeddingCount > 0 &&
        embeddingSnapshotInfo.count !== existingEmbeddingCount
      ) {
        throw new Error(
          `Embedding preservation snapshot contains ${embeddingSnapshotInfo.count} vectors, ` +
            `but metadata records ${existingEmbeddingCount}; refusing a rebuild that could lose vectors.`,
        );
      }
    } catch (err: any) {
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
      throw new Error(
        `Could not create a bounded embedding preservation snapshot; analysis stopped ` +
          `before the rebuild could discard vectors (${err?.message ?? String(err)}).`,
        { cause: err },
      );
    }
  }

  // ── Load incremental parse cache ──────────────────────────────────
  // Content-addressed: safe to reuse across `--force` runs (chunks whose
  // file contents haven't changed produce identical worker output).
  // Loaded into a single ParseCache object that the pipeline mutates
  // in-place (cache hits leave entries unchanged; misses add new ones).
  const parseCache = await loadParseCache(storagePath);

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(
    repoPath,
    (p) => {
      const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
      const scaled = Math.round(p.percent * 0.6);
      const message = p.detail
        ? `${p.message || phaseLabel} (${p.detail})`
        : p.message || phaseLabel;
      progress(p.phase, scaled, message);
    },
    {
      parseCache,
      workerPoolSize: options.workerPoolSize,
      // CFG/PDG opt-in (#2081 M1). PipelineOptions.pdg fans out to the worker
      // build gate (workerData.pdg) and the scope-resolution emit gate.
      pdg: options.pdg === true,
      pdgMaxFunctionLines: options.pdgMaxFunctionLines,
      pdgMaxEdgesPerFunction: options.pdgMaxEdgesPerFunction,
      pdgMaxReachingDefEdgesPerFunction: options.pdgMaxReachingDefEdgesPerFunction,
      pdgMaxCdgEdgesPerFunction: options.pdgMaxCdgEdgesPerFunction,
      pdgMaxTaintFindingsPerFunction: options.pdgMaxTaintFindingsPerFunction,
      pdgMaxTaintHops: options.pdgMaxTaintHops,
      pdgMaxInterprocFindings: options.pdgMaxInterprocFindings,
      pdgMaxInterprocHops: options.pdgMaxInterprocHops,
      pdgMaxInterprocEdges: options.pdgMaxInterprocEdges,
      // Streaming/chunked PDG emit (#2202) — gated to full-rebuild runs
      // (force === true) so the incremental writeback never reads back an
      // offloaded BasicBlock layer. Memory-only; byte-identical output.
      streamPdgEmit: resolveStreamPdgEmit(options),
      pdgEmitChunkSize: resolvePdgEmitChunkSize(options),
      fetchWrappers: options.fetchWrappers,
    },
  );

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');

  // Compute current per-file content hashes from the pipeline's File nodes.
  // Used both to drive the incremental DB writeback (when eligible) and to
  // populate meta.json.fileHashes for the next run.
  const allFilePaths: string[] = [];
  pipelineResult.graph.forEachNode((n) => {
    if (n.label === 'File') {
      const fp = n.properties?.filePath as string | undefined;
      if (fp) allFilePaths.push(fp);
    }
  });
  const newFileHashes = await computeFileHashes(repoPath, allFilePaths);

  // Decide incremental vs full at THIS point (post-pipeline, pre-DB).
  // All eligibility conditions are checked here against the actual
  // pipeline output — no separate pre-pipeline prediction to desync from
  // (Bugbot review on PR #1479: a prediction that flipped post-pipeline
  // could skip the embedding cache load and then take the full-rebuild
  // path, silently losing embeddings).
  const isIncremental =
    !options.force &&
    !!existingMeta &&
    existingMeta.schemaVersion === INCREMENTAL_SCHEMA_VERSION &&
    !!existingMeta.fileHashes &&
    Object.keys(existingMeta.fileHashes).length > 0 &&
    repoHasGit &&
    allFilePaths.length > 0;

  if (options.incrementalOnly && !isIncremental) {
    incrementalOnlyStop('the analyzed repository is not eligible for a surgical incremental write');
  }

  const hashDiff = isIncremental
    ? diffFileHashes(newFileHashes, existingMeta!.fileHashes)
    : undefined;

  if (isIncremental && hashDiff) {
    log(
      `Incremental: changed=${hashDiff.changed.length}, ` +
        `added=${hashDiff.added.length}, ` +
        `deleted=${hashDiff.deleted.length} ` +
        `(skipping wipe + ${
          allFilePaths.length - hashDiff.toWrite.length
        } unchanged file rows preserved)`,
    );
    // Set the dirty flag BEFORE any destructive DB mutation. Cleared on
    // success at the meta-save step. Scoped to this branch's meta.json.
    if (!options.incrementalOnly) {
      const now = Date.now();
      await savePreAdoptionMeta(metaDir, {
        ...existingMeta!,
        incrementalInProgress: {
          startedAt: now,
          updatedAt: now,
          targetCommit: currentCommit,
          phase: 'pre-write',
          toWriteCount: hashDiff.toWrite.length,
          directWriteCount: hashDiff.toWrite.length,
        },
      });
    }
  } else {
    // Full rebuild path: wipe DB files first.
    // Set the dirty flag BEFORE the wipe whenever a prior meta exists,
    // mirroring the incremental branch above (#2099 F1, KTD2b). Without it a
    // full rebuild crashing between the wipe and the end-of-run saveMeta
    // leaves a meta that vouches for a DB it no longer matches — the next
    // clean-tree run's fast path would certify a destroyed DB (or, after a
    // pdg flip, certify zombie/missing BasicBlock rows indefinitely).
    // toWriteCount: 0 is the full-path sentinel (no incremental write set).
    if (existingMeta) {
      const now = Date.now();
      await savePreAdoptionMeta(metaDir, {
        ...existingMeta,
        incrementalInProgress: {
          startedAt: now,
          updatedAt: now,
          targetCommit: currentCommit,
          phase: 'full-rebuild',
          toWriteCount: 0,
        },
      });
    }
    await closeLbug();
    // Shared loud wipe (#2409 + tri-review 4669518496 P2-4). The 4-file
    // family list — `.shadow` included, because a checkpoint-in-flight crash
    // leaves a shadow sidecar that is replay poison next to a freshly created
    // DB file — lives in wipeLbugDbFiles so this site and the escalation
    // valve below can never drift. Failures now throw a typed LbugWipeError
    // (ENOENT-verified removal) instead of silently letting initLbug reopen
    // a still-populated DB this run believes it wiped.
    await wipeLbugDbFiles(lbugPath);
  }

  const streamedPdgRows = pipelineResult.pdgEmitManifest
    ? [
        ...pipelineResult.pdgEmitManifest.nodeFiles.values(),
        ...pipelineResult.pdgEmitManifest.relsByPair.values(),
      ].reduce((total, entry) => total + entry.rows, 0)
    : 0;
  setBufferPoolSizeHint(
    estimateBufferPool(
      pipelineResult.graph.nodeCount + pipelineResult.graph.relationshipCount + streamedPdgRows,
    ),
  );

  if (options.incrementalOnly) {
    await withLbugDb(lbugPath, async () => undefined, { readOnly: true });
  } else {
    await initLbug(lbugPath);
  }

  // Manual WAL checkpoint driver (#1741): periodically drain the WAL
  // from JS so the un-retriable native auto-checkpoint almost never
  // has work left to do. Failures of the manual CHECKPOINT are absorbed
  // by the driver's bounded retry; the final un-recoverable error still
  // surfaces via the surrounding write that follows the failed flush.
  // Opt-out via `GITNEXUS_WAL_MANUAL_CHECKPOINT=0` (the driver itself
  // returns a no-op handle when disabled). Analyze-only: MCP and serve
  // paths continue to rely on the close-time CHECKPOINT in `safeClose`.
  // `let`: the incremental branch's escalation valve (#2409) stops this driver
  // around its close→wipe→reopen strategy switch and starts a fresh one.
  let walCheckpointDriver: WalCheckpointDriver = options.incrementalOnly
    ? { stop: async () => undefined }
    : startWalCheckpointDriver();
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    // #2409 escalation valve outcome, hoisted above the incremental branch so
    // the vector-index recreation seam in Phase 4 below can tell "surgical
    // incremental" (DB files survived — the HNSW index with them) apart from
    // "escalated full write" (DB wiped, index destroyed) — tri-review
    // 4669518496 P1.
    let escalatedFullWrite = false;
    // Phase 3.5's restore scope (FIX 3 of this shipping review): on the
    // SURGICAL write plan this is the exact file set whose rows
    // deleteNodesForFiles just removed — only THOSE files' cached embedding
    // rows need re-inserting (everything else still sits in the DB, and
    // re-inserting it would PK-conflict). `null` means the DB was wiped
    // (full rebuild or escalated write): the embedding table is fresh and
    // every cached row must come back. Deriving this in memory replaces the
    // old whole-table `RETURN e.id` pre-read, which rescanned data this
    // process already holds and — worse — ran a read against the DB between
    // writeback and finalize for no recovery benefit.
    let deletedFilePathsForRestore: Set<string> | null = null;
    if (isIncremental && hashDiff) {
      // ── Incremental DB writeback ───────────────────────────────────
      // 0. Expand the writable set with transitive importers of
      //    changed/deleted files (bounded BFS).
      //
      //    Reason (Bugbot/Claude review on PR #1479): when a barrel /
      //    re-export file C changes, cross-file resolution may update
      //    CALLS edges between two unchanged files A and B (A imports
      //    from C, C re-exports something from B). Those refined edges
      //    live in `ctx.graph` but would be excluded from the subgraph
      //    if neither endpoint is in the changed set. To catch this,
      //    files that imported (directly OR transitively, through
      //    other unchanged intermediaries) any changed file get pulled
      //    into the writable set so their rows are deleted + rewritten
      //    against the refined edges.
      //
      //    BFS bound: MAX_IMPORTER_BFS_DEPTH. Practically sized to
      //    catch nested barrel chains (e.g. `index.ts → submodule/index.ts
      //    → submodule/impl.ts`) without ballooning into a near-full-
      //    rebuild on monorepos with deep re-export pyramids. Beyond
      //    this depth, the "incremental ≡ full-rebuild" invariant is
      //    self-acknowledged as best-effort; `--force` remains the
      //    escape hatch documented in GUARDRAILS.md.
      //
      //    `queryImportersBatch` reads `IMPORTS` from the pre-pipeline DB
      //    state, so the result is "files that USED TO import the
      //    target" — exactly the set whose previously-stored edges may
      //    no longer match what cross-file resolution produces this run.
      const MAX_IMPORTER_BFS_DEPTH = 4;
      // Escalation thresholds (#2409) live with shouldEscalateIncrementalWrite
      // in incremental/escalation-gate.ts (pure predicate, boundary-tested).
      const writableFiles = new Set<string>(hashDiff.toWrite);
      const directlyChangedCount = writableFiles.size;
      const dirtyStartedAt = existingMeta!.incrementalInProgress?.startedAt ?? Date.now();
      let incrementalMutationAuthorized = !options.incrementalOnly;
      // Dropped-chunk observability (tri-review 4669518496 P2-5): counts
      // importer-BFS chunks whose IMPORTS query failed across ALL depths
      // (degrade-don't-fail — the expansion shrinks instead of the run
      // dying). Stamped into the #2410 crash diagnostics by
      // saveIncrementalDirtyState ITSELF (FIX 6 of this shipping review),
      // not by per-call-site spreads: the closure rebuilds its object from
      // scratch on every call, so a count riding along at only some sites
      // meant any newly added save site would silently erase it — exactly
      // the phases where #2409-class crashes happen. >0-only semantics
      // unchanged: unconditional zero-stamping would churn every
      // strict-equality consumer of the diagnostics shape.
      let droppedImporterChunks = 0;
      const saveIncrementalDirtyState = async (
        phase: string,
        extra: Partial<NonNullable<RepoMeta['incrementalInProgress']>> = {},
      ): Promise<void> => {
        if (!incrementalMutationAuthorized) return;
        await savePreAdoptionMeta(metaDir, {
          ...existingMeta!,
          incrementalInProgress: {
            startedAt: dirtyStartedAt,
            updatedAt: Date.now(),
            targetCommit: currentCommit,
            phase,
            toWriteCount: writableFiles.size,
            directWriteCount: directlyChangedCount,
            ...(droppedImporterChunks > 0 ? { droppedImporterChunks } : {}),
            ...extra,
          },
        });
      };

      // Shadow-seed: for ADDED files, the importer query returns 0 (the new
      // file has no IMPORTS rows in the pre-pipeline DB yet). But pre-
      // existing unchanged files may have IMPORTS edges whose module-
      // resolution claim the newcomer can steal under standard JS/TS
      // resolution (Bugbot review on PR #1479). For each added file we
      // derive the shadow candidates and, if the candidate was a known
      // file in the prior meta, seed it into the BFS frontier so its
      // importers — surfaced via the importer BFS — get their CALLS edges
      // re-resolved against the new file. See shadow-candidates.ts for
      // the full pattern catalogue.
      const priorFileSet = new Set<string>(
        existingMeta?.fileHashes ? Object.keys(existingMeta.fileHashes) : [],
      );
      const shadowSeed: string[] = [];
      for (const added of hashDiff.added) {
        for (const cand of shadowCandidatesFor(added)) {
          if (priorFileSet.has(cand) && !writableFiles.has(cand)) {
            shadowSeed.push(cand);
          }
        }
      }

      {
        // Batched per depth level (#2409): one IN-list query per ~200-path
        // chunk instead of one query per frontier file — a ~700-file frontier
        // used to cost ~700 sequential lock-taking round-trips (~5.6s). The
        // closure is identical: importers already in writableFiles are not
        // re-frontiered, exactly like the per-file loop's membership check.
        let frontier: string[] = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowSeed];
        for (let depth = 0; depth < MAX_IMPORTER_BFS_DEPTH && frontier.length > 0; depth++) {
          const importers = await queryImportersBatch(frontier, {
            onChunkFailure: () => {
              droppedImporterChunks += 1;
            },
          });
          const nextFrontier: string[] = [];
          for (const i of importers) {
            if (!writableFiles.has(i)) {
              writableFiles.add(i);
              nextFrontier.push(i);
            }
          }
          frontier = nextFrontier;
        }
      }
      const importerExpansion = writableFiles.size - directlyChangedCount;
      await saveIncrementalDirtyState('importer-bfs', {
        importerExpansion,
        shadowSeedCount: shadowSeed.length,
      });
      if (importerExpansion > 0) {
        log(
          `Incremental: +${importerExpansion} importer(s) added to writable set ` +
            `(BFS depth ≤ ${MAX_IMPORTER_BFS_DEPTH}` +
            (shadowSeed.length > 0 ? `, ${shadowSeed.length} shadow-seed(s)` : '') +
            `)`,
        );
      }

      // 1. Compute the EFFECTIVE write-set (Finding 1). Two layers,
      //    composed:
      //      (a) `writableFiles` — toWrite ∪ transitive importers of
      //          changed/deleted files (the bounded BFS above, reading
      //          IMPORTS from the pre-pipeline DB).
      //      (b) `computeEffectiveWriteSet` — walks the NEW graph's
      //          edges and pulls in any unchanged-side file that sits
      //          on a writable-boundary-crossing edge (catches refined
      //          cross-file CALLS edges that the pre-run DB couldn't
      //          predict, e.g. a barrel re-export shifting `foo` from
      //          B to D).
      //    The composed set is the input to BOTH deleteNodesForFiles
      //    and extractChangedSubgraph — asymmetry between the two would
      //    leave stale rows or PK-conflict at COPY time.
      const effectiveWriteSet = computeEffectiveWriteSet(pipelineResult.graph, writableFiles);
      // Deduped: deleted entries may already appear via importer-BFS
      // expansion (the importer BFS can return a now-deleted path), which
      // would otherwise hand deleteNodesForFiles the same path twice in one
      // batch (Bugbot LOW finding on PR #1479).
      const filesToDelete = [...new Set([...effectiveWriteSet, ...hashDiff.deleted])];
      await saveIncrementalDirtyState('effective-write-set', {
        importerExpansion,
        shadowSeedCount: shadowSeed.length,
        effectiveWriteCount: effectiveWriteSet.size,
        deleteCount: filesToDelete.length,
      });

      // Escalation valve (#2409): when the effective write set covers most of
      // the repo, per-file surgery is strictly worse than the proven
      // wipe-and-bulk-COPY plan — the same data volume lands either way, but
      // the surgical plan pays per-table deletes plus COPY-into-non-empty
      // tables, and at this size it measured SLOWER than a full DB load. The
      // pipeline already produced the FULL graph (it always does), so only the
      // DB write plan changes here; fileHashes/meta bookkeeping is identical.
      // Thresholds + the AND-gate live in incremental/escalation-gate.ts.
      const writeFraction = effectiveWriteSet.size / Math.max(1, allFilePaths.length);
      if (
        shouldEscalateIncrementalWrite(
          filesToDelete.length,
          effectiveWriteSet.size,
          allFilePaths.length,
        )
      ) {
        if (options.incrementalOnly) {
          incrementalOnlyStop(
            `the effective write set (${effectiveWriteSet.size}/${allFilePaths.length} files, ` +
              `${filesToDelete.length} deletions) crossed the full-rebuild escalation threshold`,
          );
        }
        escalatedFullWrite = true;
        log(
          `Incremental: effective write set covers ${effectiveWriteSet.size}/${allFilePaths.length} ` +
            // Display clamp only (predicate unchanged): BFS-found deleted
            // importers can push the numerator past the CURRENT file list, so
            // the raw fraction can exceed 1 — see the population-mismatch note
            // on shouldEscalateIncrementalWrite (tri-review 4669518496).
            `files (${Math.min(100, Math.round(writeFraction * 100))}%) — switching to a full DB write ` +
            `(wipe + bulk COPY) for this run; file-level incremental bookkeeping is unaffected.`,
        );
        // toWriteCount: 0 is the established full-path dirty-flag sentinel;
        // the real counters ride along for crash diagnostics.
        await saveIncrementalDirtyState('escalated-full-write', {
          toWriteCount: 0,
          importerExpansion,
          shadowSeedCount: shadowSeed.length,
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        callbacks.onRecoveryBoundary?.('before-delete', {
          phase: 'escalated-full-write',
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        // Strategy switch: stop the checkpoint driver around the close so its
        // in-flight CHECKPOINT can't race the reopen, drop the DB files
        // (sidecars included), and bulk-load the full graph into a fresh DB —
        // byte-for-byte the full-rebuild write plan. The wipe is the shared
        // ENOENT-verified helper (#2409 + tri-review 4669518496 P2-4): a
        // surviving family member throws a typed LbugWipeError here instead
        // of letting the reopen below resurrect the rows this run just chose
        // to replace wholesale.
        await walCheckpointDriver.stop();
        await closeLbug();
        let deletionBoundaryReported = false;
        await wipeLbugDbFiles(lbugPath, {
          onRemoved: (removedPath, index, total) => {
            if (deletionBoundaryReported) return;
            deletionBoundaryReported = true;
            callbacks.onRecoveryBoundary?.('during-delete', {
              phase: 'escalated-full-write',
              removedPath,
              index,
              total,
            });
          },
        });
        await saveIncrementalDirtyState('escalated-load-graph', {
          toWriteCount: 0,
          importerExpansion,
          shadowSeedCount: shadowSeed.length,
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        await initLbug(lbugPath);
        walCheckpointDriver = startWalCheckpointDriver();
        let insertionBoundaryReported = false;
        await loadGraphToLbug(
          pipelineResult.graph,
          pipelineResult.repoPath,
          storagePath,
          (msg) => {
            lbugMsgCount++;
            const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
            progress('lbug', pct, msg);
          },
          undefined,
          {
            onNodeCopyCommitted: (table, index, total) => {
              if (insertionBoundaryReported) return;
              insertionBoundaryReported = true;
              callbacks.onRecoveryBoundary?.('during-insert', {
                phase: 'escalated-load-graph',
                table,
                index,
                total,
              });
            },
          },
        );
      } else {
        // The surgical plan is now final. Only at this point may
        // --incremental-only write its crash marker, immediately before the
        // first destructive DB operation.
        if (options.incrementalOnly) {
          incrementalMutationAuthorized = true;
          await saveIncrementalDirtyState('effective-write-set', {
            importerExpansion,
            shadowSeedCount: shadowSeed.length,
            effectiveWriteCount: effectiveWriteSet.size,
            deleteCount: filesToDelete.length,
          });
          // Importer closure was inspected through a read-only connection so a
          // refusal cannot rewrite graph bytes. Upgrade only after the crash
          // marker is durable and the surgical plan is final.
          await walCheckpointDriver.stop();
          await closeLbug();
          await initLbug(lbugPath);
          walCheckpointDriver = startWalCheckpointDriver();
        }
        // 1a. Remove the write set's existing rows — batched (#2409): one
        //     DETACH DELETE per table per 200-file chunk. The former per-file
        //     loop issued a count + delete per table per FILE — ~13k
        //     single-row write transactions on a ~700-file write set — which
        //     made this phase slower than a full rebuild and is the WAL-append
        //     storm behind the native mid-writeback deaths in #2409. Errors
        //     are NOT swallowed anymore: a zero-match file is a no-op by
        //     construction, so anything thrown is a real engine failure that
        //     must surface instead of silently skipping (that silent skip was
        //     how #2409 hid its root cause).
        progress('lbug', 62, `Removing rows for changed files (0/${filesToDelete.length})...`);
        await deleteNodesForFiles(filesToDelete, {
          onChunk: (done, total) =>
            progress('lbug', 62, `Removing rows for changed files (${done}/${total})...`),
        });
        // Surgical path: Phase 3.5 restores exactly these files' embedding
        // rows (FIX 3). Sound because deleteNodesForFiles propagates errors
        // — reaching this line means every listed file's rows are gone
        // deterministically — and this process holds the exclusive DB lock,
        // so no concurrent writer can disturb the derivation.
        deletedFilePathsForRestore = new Set(filesToDelete);
        // 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
        //    from the fresh pipeline output below. Required for the
        //    "Leiden runs on the FULL graph" correctness invariant.
        await deleteAllCommunitiesAndProcesses();
        // 2a. Drop INJECTS edges (DI collection injection, #2200) — their
        //     validity is a whole-program property (a third-file change to the
        //     interface or an implementer creates/invalidates edges between two
        //     untouched files), so endpoint-writability extraction can't refresh
        //     them; extractChangedSubgraph re-includes all of them from the
        //     fresh graph (isGraphWideRelType). UNCONDITIONAL, next to the
        //     Communities delete — NOT inside the `options.pdg` block below: the
        //     di phase runs on every persisting analyze (same !skipGraphPhases
        //     regime as communities/processes) while the graph-wide re-include
        //     is unconditional, so a pdg-gated delete would append without
        //     deleting on every non-pdg incremental run (N runs = N copies of
        //     every INJECTS row; CodeRelation has no PK and no read-side dedup).
        await deleteAllInjects();
        // 2b. Drop interprocedural TAINT_PATH edges (#2084 M4 U6) when pdg is on
        //     — their validity is a whole-program property (an A→C flow can be
        //     invalidated by a change to an intermediate function on a third
        //     file), so endpoint-writability extraction can't refresh them.
        //     extractChangedSubgraph re-includes all of them from the fresh
        //     graph (isGraphWideRelType), mirroring Community/Process.
        if (options.pdg === true) {
          await deleteAllInterprocTaintPaths();
          // 2c. Drop CALL_SUMMARY edges (PDG FU-C) on an incremental `--pdg`
          //     writeback. They are re-included from the FULL fresh graph
          //     (isGraphWideRelType) and the callSummaries phase recomputes every
          //     summary each run, so delete-all-then-rebuild keeps an unchanged
          //     function's summary from being lost — same contract as TAINT_PATH.
          await deleteAllCallSummaries();
        }

        // 3. Extract the changed subgraph from the FULL ctx.graph and write
        //    only that. Unchanged-file rows in the DB stay untouched. Pass
        //    the SAME effectiveWriteSet so the subgraph and the deletes
        //    cover identical files (asymmetry would silently corrupt).
        const subgraph = extractChangedSubgraph(pipelineResult.graph, effectiveWriteSet);
        await saveIncrementalDirtyState('load-graph', {
          importerExpansion,
          shadowSeedCount: shadowSeed.length,
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        await loadGraphToLbug(subgraph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
          progress('lbug', pct, msg);
        });
      }

      // Boundary drain (#2409): checkpoint at the end of the incremental
      // writeback so the WAL it accumulated never lingers into the FTS and
      // embedding phases — a later crash leaves only post-checkpoint WAL for
      // the next open to replay. Near-instant when the periodic driver has
      // kept up; rides the driver's bounded retry via runCheckpointWithRetry.
      await checkpointOnce();
    } else {
      // ── Full rebuild ───────────────────────────────────────────────
      // Pass the streamed PDG-emit manifest (#2202) so the BasicBlock layer that
      // was flushed to CSV during the emit loop is COPY'd alongside the
      // structural CSVs. Only ever set on a full rebuild (streaming is
      // force-gated), so the incremental branch above never carries it.
      await loadGraphToLbug(
        pipelineResult.graph,
        pipelineResult.repoPath,
        storagePath,
        (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
          progress('lbug', pct, msg);
        },
        pipelineResult.pdgEmitManifest,
      );
    }

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    // The analyze (write) path owns building the search indexes, so it uses
    // the `auto` install policy (LOAD-first, then one bounded INSTALL) —
    // symmetric with the VECTOR/embeddings path below and consistent with the
    // #726 contract. The global `load-only` default (PR #1161) governs the
    // serve/query read paths, not this one. When the extension still cannot be
    // loaded (genuinely offline + not pre-installed, or policy forced to
    // load-only/never), degrade gracefully — exactly like the VECTOR path — so
    // analyze still produces a fully queryable graph; only full-text/BM25
    // search falls back. `--repair-fts` (whose sole job is FTS) still fails
    // loudly on its own path above.
    progress('fts', 85, 'Creating search indexes...');
    const ftsAvailable = await loadFTSExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
    if (ftsAvailable) {
      await createSearchFTSIndexes({
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const missingIndexNames = await verifySearchFTSIndexes(executeQuery);
      if (missingIndexNames.length > 0) {
        throw new Error(
          `FTS verification failed - missing indexes after analyze: ${missingIndexNames.join(', ')}. ` +
            'Check FTS extension availability, then retry `gitnexus analyze --force` for a full rebuild.',
        );
      }
      progress('fts', 90, 'Search indexes ready');
    } else {
      // For a missing runtime dependency (#2374) the file is present, so the
      // generic "install it with network access" tail in FTS_UNAVAILABLE_MESSAGE
      // contradicts the remedy's own "reinstalling will NOT help" (#2383 F2). Lead
      // with the class-neutral sentence and append only the classified remedy.
      const ftsReason = getExtensionCapabilities().find((c) => c.name === 'fts')?.reason;
      const { kind, remedy } = diagnoseExtensionLoad(ftsReason);
      log(
        kind === 'missing_dependency'
          ? `${FTS_UNAVAILABLE_LEAD} ${remedy}`
          : FTS_UNAVAILABLE_MESSAGE,
      );
      progress('fts', 90, 'Search indexes skipped (FTS unavailable)');
    }

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    // Runs on BOTH the full-rebuild path and the incremental path:
    //   - Full rebuild / escalated write: DB was wiped, every cached row
    //     needs to come back.
    //   - Incremental (surgical): changed/deleted files' rows were just
    //     deleted by deleteNodesForFiles (a REAL delete since tri-review
    //     4669518496 P2-1 — it joins embedding rows through their owning
    //     nodes), so changed-file vectors need to come back; unchanged-file
    //     rows still exist. Bugbot review on PR #1479 flagged that gating
    //     this on `!isIncremental` silently lost changed-file embeddings.
    //
    // Restore discipline (tri-review 4669518496 / KTD10, restore scope
    // derived in memory since FIX 3 of this shipping review) — filtered and
    // conflict-free, replacing the old insert-everything-and-swallow shape:
    //   1. Live-graph filter: rows whose nodeId no longer exists in the
    //      freshly-built FULL graph are dropped. The cache was read BEFORE
    //      the pipeline ran, so it still carries deleted files' rows —
    //      re-inserting them resurrected orphans (wholesale onto the wiped
    //      paths' empty table) now that the delete above is real.
    //   2. Restore-scope filter, derived WITHOUT touching the DB (the old
    //      shape pre-read every surviving embedding id back out of the
    //      table it had just written): on a wiped path
    //      (`deletedFilePathsForRestore === null`) the table is fresh, so
    //      every live row comes back; on the surgical path only rows whose
    //      owning node's filePath is in the just-join-deleted set are
    //      inserted — everything else still sits in the DB and would
    //      PK-conflict. The derivation is sound because deleteNodesForFiles
    //      propagates errors (a completed writeback means a deterministic
    //      delete outcome) and this process holds the exclusive DB lock (no
    //      concurrent writer).
    // Restore insertion failures propagate: silently skipping a failed batch
    // would finalize metadata with fewer vectors than the preserved snapshot.
    let restoredEmbeddingCount = 0;
    let skippedPendingEmbeddingRows = 0;
    // Keep exact known row identities and one restored hash per owner node; vectors
    // still stream through the bounded 256-row snapshot batches above. The
    // exact row IDs are required because LadybugDB can make freshly restored
    // non-PK nodeId predicates temporarily miss rows even while the PK sees
    // them. Without this sidecar, stale regeneration can issue CREATE for a
    // row that already exists and fail with a duplicate primary key (#155).
    const restoredEmbeddingHashes = new Map<string, string>();
    const restoredEmbeddingRowIds = new Map<string, string[]>();
    if (
      shouldRecreateStagedEmbeddingTableForResume(
        rebuildStagedEmbeddingTableForResume,
        embeddingSnapshotInfo,
      )
    ) {
      if (embeddingSnapshotInfo.count > 0) {
        const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
        if (embeddingSnapshotInfo.dimensions !== EMBEDDING_DIMS) {
          throw new Error(
            `Cannot recreate the staged embedding table from a ` +
              `${embeddingSnapshotInfo.dimensions}-dimensional snapshot; this run requires ` +
              `${EMBEDDING_DIMS} dimensions.`,
          );
        }
      }
      progress('embeddings', 87, 'Recreating the isolated staged embedding table...');
      const { resolveEmbeddingInstallPolicy } = await import('./embeddings/embedding-pipeline.js');
      await recreateCodeEmbeddingTable({ policy: resolveEmbeddingInstallPolicy() });
      // The table is now empty even if graph writeback was surgical. Restore
      // every live non-pending snapshot row, not only changed-file rows.
      deletedFilePathsForRestore = null;
    }
    if (embeddingSnapshotInfo && embeddingSnapshotInfo.count > 0) {
      const cachedDims = embeddingSnapshotInfo.dimensions;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
      } else {
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        progress(
          'embeddings',
          88,
          `Restoring ${embeddingSnapshotInfo.count} cached embeddings in bounded batches...`,
        );
        await readEmbeddingSnapshot(
          embeddingSnapshotPath,
          embeddingSnapshotSource,
          async (snapshotBatch) => {
            const rowsToRestore = [];
            const orphanRowIds: string[] = [];
            for (const embedding of snapshotBatch) {
              // A persisted checkpoint window is deliberately regenerated below.
              // Restoring those rows first creates a delete-then-create cycle that
              // LadybugDB's live VECTOR index can still reject as a duplicate key
              // after an interrupted staged rebuild. The checkpoint bounds this
              // exclusion to at most the pending window; every skipped row is
              // force-selected by runEmbeddingPipeline before finalization.
              if (resumeEmbeddingCheckpoint && pendingEmbeddingNodeIds.has(embedding.nodeId)) {
                skippedPendingEmbeddingRows += 1;
                // The staged database can already contain this row from the
                // interrupted window even though its non-PK nodeId lookup is
                // temporarily invisible behind LadybugDB's live VECTOR index.
                // Carry the exact primary key without its reusable hash so the
                // pipeline deletes it immediately before regenerating the batch.
                const rowIds = restoredEmbeddingRowIds.get(embedding.nodeId) ?? [];
                rowIds.push(`${embedding.nodeId}:${embedding.chunkIndex}`);
                restoredEmbeddingRowIds.set(embedding.nodeId, rowIds);
                continue;
              }
              const liveNode = pipelineResult.graph.getNode(embedding.nodeId);
              if (!liveNode) {
                if (deletedFilePathsForRestore !== null) {
                  orphanRowIds.push(`${embedding.nodeId}:${embedding.chunkIndex}`);
                }
                continue;
              }
              if (deletedFilePathsForRestore !== null) {
                const filePath = liveNode.properties?.filePath;
                if (typeof filePath !== 'string' || !deletedFilePathsForRestore.has(filePath)) {
                  continue;
                }
              }
              rowsToRestore.push(embedding);
            }
            if (rowsToRestore.length > 0) {
              await batchInsert(executeWithReusedStatement, rowsToRestore);
              restoredEmbeddingCount += rowsToRestore.length;
              for (const embedding of rowsToRestore) {
                const restoredHash = embedding.contentHash || STALE_HASH_SENTINEL;
                const priorHash = restoredEmbeddingHashes.get(embedding.nodeId);
                restoredEmbeddingHashes.set(
                  embedding.nodeId,
                  priorHash === undefined || priorHash === restoredHash
                    ? restoredHash
                    : STALE_HASH_SENTINEL,
                );
                const rowIds = restoredEmbeddingRowIds.get(embedding.nodeId) ?? [];
                rowIds.push(`${embedding.nodeId}:${embedding.chunkIndex}`);
                restoredEmbeddingRowIds.set(embedding.nodeId, rowIds);
              }
            }
            if (orphanRowIds.length > 0) {
              try {
                for (let i = 0; i < orphanRowIds.length; i += DELETE_FILES_CHUNK_SIZE) {
                  const chunk = orphanRowIds.slice(i, i + DELETE_FILES_CHUNK_SIZE);
                  const listLiteral = `[${chunk
                    .map((id) => `'${escapeCypherString(id)}'`)
                    .join(', ')}]`;
                  await executeQuery(
                    `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.id IN ${listLiteral} DELETE e`,
                  );
                }
                log(
                  `Swept ${orphanRowIds.length} cached embedding row(s) with no live owning node.`,
                );
              } catch (err) {
                log(
                  `Warning: could not sweep ${orphanRowIds.length} orphaned embedding ` +
                    `row(s) (${(err as Error).message}); they are unreachable by search ` +
                    'joins and will be retried next run.',
                );
              }
            }
          },
          resumeEmbeddingCheckpoint ? undefined : existingEmbeddingCount,
          embeddingSnapshotValidationOptions,
        );
        if (skippedPendingEmbeddingRows > 0) {
          log(
            `Skipped ${skippedPendingEmbeddingRows} cached embedding row(s) from the ` +
              'pending checkpoint window; they will be regenerated.',
          );
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();
    let embeddingSkipped = true;
    let semanticMode: 'vector-index' | 'exact-scan' | undefined;
    let httpMode = false;

    if (shouldGenerateEmbeddings) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      httpMode = isHttpMode();
      const { skipForCap, capDisabled, nodeLimit } = deriveEmbeddingCap(
        stats.nodes,
        resolveEmbeddingNodeLimit(options.embeddingsNodeLimit, resumeEmbeddingCheckpoint),
        httpMode,
      );
      if (!skipForCap) {
        embeddingSkipped = false;
        if (capDisabled && stats.nodes > DEFAULT_EMBEDDING_NODE_LIMIT) {
          if (httpMode) {
            log(
              `Remote embedding endpoint selected — generating embeddings for ` +
                `${stats.nodes.toLocaleString()} nodes; the ` +
                `${DEFAULT_EMBEDDING_NODE_LIMIT.toLocaleString()}-node local-model cap ` +
                `does not apply.`,
            );
          } else {
            log(
              `Embedding node-count cap disabled — generating embeddings for ` +
                `${stats.nodes.toLocaleString()} nodes. Ensure sufficient memory; ` +
                `the default ${DEFAULT_EMBEDDING_NODE_LIMIT.toLocaleString()}-node ` +
                `local-model cap exists to prevent OOM.`,
            );
          }
        }
      } else {
        log(
          `Embeddings skipped: ${stats.nodes.toLocaleString()} nodes exceeds ` +
            `the ${nodeLimit.toLocaleString()}-node safety cap. ` +
            `Override with \`--embeddings 0\` to disable the cap, or ` +
            `\`--embeddings <n>\` to set a custom cap.`,
        );
      }
    }

    // ── Vector-index recreation after a wipe-and-restore (tri-review
    // 4669518496 P1 / KTD1) ────────────────────────────────────────────
    // The full-rebuild and escalated-incremental write plans wipe the DB
    // files — the HNSW index with them. Phase 3.5 brought the embedding ROWS
    // back, but on a preserve-only run nothing recreates the index: semantic
    // search silently loses its vector lane (>10k-embedding repos return
    // empty under the exact-scan cap) while meta certified 'vector-index'.
    // Recreate it here, where every gate input is settled:
    //   - restoredEmbeddingCount > 0 — rows actually came back;
    //   - dbWasWiped — surgical incremental runs keep their index (HNSW
    //     self-maintains on insert/delete); only wiped DBs lost it;
    //   - embeddingSkipped — evaluated AFTER the deriveEmbeddingCap decision
    //     above, NOT `!shouldGenerateEmbeddings`: when Phase 4 really runs,
    //     the pipeline builds the index itself after all inserts (firing this
    //     seam first would swap its bulk build for per-row live HNSW
    //     maintenance on the hottest flow), while a capped >50k-node repo has
    //     shouldGenerateEmbeddings=true yet never runs the pipeline — exactly
    //     the case a naive gate would leave index-less again.
    // buildVectorIndex carries its own extension-policy gate and
    // warn-on-failure; the boolean feeds semanticMode so the finalize stamp
    // reflects the DB's ACTUAL state even when recreation fails (win32 /
    // extension unavailable → 'exact-scan').
    const dbWasWiped = !isIncremental || escalatedFullWrite;
    if (restoredEmbeddingCount > 0 && dbWasWiped && embeddingSkipped) {
      // Re-import at the seam rather than thread a mutable capture from
      // Phase 3.5 (FIX 3 of this shipping review — the captured function was
      // a fragile moving part): dynamic imports are memoized, and
      // `restoredEmbeddingCount > 0` proves Phase 3.5 already loaded the
      // module, so the lazy-embeddings convention (#2370) holds — no
      // embeddings module loads unless a restore actually happened.
      const { buildVectorIndex } = await import('./embeddings/embedding-pipeline.js');
      const vectorIndexReady = await buildVectorIndex();
      semanticMode = vectorIndexReady ? 'vector-index' : 'exact-scan';
    }

    if (!embeddingSkipped) {
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      const { fetchExistingEmbeddingHashesForNodeIds } = await import('./lbug/lbug-adapter.js');
      embeddingIdentityForRun ??= await resolveEmbeddingIdentity();
      const embeddingIdentity = embeddingIdentityForRun;
      const saveEmbeddingCheckpoint = async (
        checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        },
        pendingNodeIds: string[],
        embeddings: number | undefined,
        integrity?: EmbeddingIntegrityReport,
      ): Promise<void> => {
        const fileHashes: Record<string, string> = {};
        for (const [key, value] of newFileHashes) fileHashes[key] = value;
        await savePreAdoptionMeta(metaDir, {
          ...(existingMeta ?? {}),
          repoPath: persistedRepoPath,
          lastCommit: currentCommit,
          indexedAt: new Date().toISOString(),
          branch: branchLabel ?? existingMeta?.branch,
          remoteUrl: repositoryRemoteUrl,
          stats: {
            files: pipelineResult.totalFileCount,
            nodes: stats.nodes,
            edges: stats.edges,
            communities: pipelineResult.communityResult?.stats.totalCommunities,
            processes: pipelineResult.processResult?.stats.totalProcesses,
            embeddings,
          },
          // Schema identity belongs to the index, not Git history. Non-Git
          // staged checkpoints need the same stamp to resume safely.
          schemaVersion: INCREMENTAL_SCHEMA_VERSION,
          cjkSegmentation: getSearchFTSCjkSegmentation(),
          fileHashes: hasGitDir(repoPath) ? fileHashes : undefined,
          cacheKeys: [...parseCache.usedKeys],
          incrementalInProgress: undefined,
          embeddingCheckpoint: {
            at: new Date().toISOString(),
            ...checkpoint,
            provider: embeddingIdentity.provider,
            model: embeddingIdentity.model,
            dimensions: embeddingIdentity.dimensions,
            pendingNodeIds,
            physicalRows: integrity?.physicalRows,
            validRows: integrity?.validRows,
            recoverableIdentitySha256: integrity?.recoverableIdentitySha256,
          },
          pdg: resolvePdgConfig(options),
        });
      };

      const embeddingResult = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        undefined,
        undefined,
        {
          forceReembedNodeIds: pendingEmbeddingNodeIds,
          existingEmbeddingRowIds: restoredEmbeddingRowIds,
          rebuildVectorIndexBeforeMutation:
            Boolean(stagedPaths) && resumeEmbeddingCheckpoint && pendingEmbeddingNodeIds.size > 0,
          loadExistingEmbeddingHashes: async (nodeIds) => {
            const hashes = await fetchExistingEmbeddingHashesForNodeIds(executeQuery, nodeIds);
            for (const nodeId of nodeIds) {
              const restoredHash = restoredEmbeddingHashes.get(nodeId);
              if (restoredHash !== undefined) hashes.set(nodeId, restoredHash);
            }
            return hashes;
          },
          onCheckpointWindowStart: async ({ nodeIds, ...checkpoint }) => {
            await saveEmbeddingCheckpoint(checkpoint, nodeIds, existingMeta?.stats?.embeddings);
          },
          onCheckpoint: async (checkpoint) => {
            await checkpointOnce();
            const integrity = await inspectEmbeddingIntegrity();
            assertEmbeddingIntegrity(integrity, 'Completed embedding checkpoint');
            await saveEmbeddingCheckpoint(checkpoint, [], integrity.validRows, integrity);
          },
        },
      );
      if (embeddingResult.semanticMode === 'exact-scan') {
        semanticMode = 'exact-scan';
        log(
          'Semantic embeddings were generated without a VECTOR index; ' +
            'queries will use exact-scan fallback within the configured limit.',
        );
      } else {
        semanticMode = 'vector-index';
      }
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');

    // Finalization, metadata, and registration trust only canonical live rows.
    const terminalIntegrity = await inspectEmbeddingIntegrity();
    assertEmbeddingIntegrity(terminalIntegrity, 'Terminal embedding finalization');
    const embeddingCount = terminalIntegrity.validRows;

    if (!embeddingSkipped && stats.nodes > 0 && embeddingCount === 0) {
      throw new Error(
        'Embedding generation completed without persisted embeddings. ' +
          'The index was not registered to avoid silently reporting embeddings: 0.',
      );
    }

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    // `semanticMode` is authoritative when set (Phase 4 reported what it
    // built, or the wipe-and-restore seam above verified/recreated the index
    // — tri-review 4669518496 P1). When unset, prefer the PREVIOUS run's
    // persisted stamp over the platform capability (FIX 3, finder A): the
    // unset case is exactly a run that neither wiped nor generated — e.g. a
    // surgical incremental whose index survived in place — and such a run
    // cannot change whether the HNSW index exists, so carrying the persisted
    // observation forward is strictly more truthful than re-deriving from
    // what the platform COULD do. Only the two positive observations carry
    // ('vector-index'/'exact-scan'); 'unavailable'/absent falls through to
    // the platform default rather than pinning a stale negative.
    const persistedStatus = existingMeta?.capabilities?.vectorSearch.status;
    const persistedSemanticMode: 'vector-index' | 'exact-scan' | undefined =
      persistedStatus === 'vector-index' || persistedStatus === 'exact-scan'
        ? persistedStatus
        : undefined;
    const effectiveSemanticMode =
      semanticMode ??
      persistedSemanticMode ??
      (runtimeCapabilities.semanticMode === 'vector-index' ? 'vector-index' : 'exact-scan');

    // Convert the post-run file-hash map to the on-disk Record<string,string>
    // shape consumed by RepoMeta.fileHashes.
    const newFileHashesRecord: Record<string, string> = {};
    for (const [k, v] of newFileHashes) newFileHashesRecord[k] = v;

    // Annotated so the capabilities stamp below is compile-checked against
    // RepoMeta's status unions (tri-review 4669518496 P1/U3) — an unannotated
    // literal widens the vectorSearch.status ternary to `string` and the
    // honesty contract silently decays to "whatever interpolates".
    const meta: RepoMeta = preservePreAdoptionBranch({
      repoPath: persistedRepoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      // Branch identity this index represents (#2106). Recorded for the flat
      // slot too (so resolveBranchPlacement knows which branch owns it). When
      // the label is null (detached HEAD / non-git re-analyze) we PRESERVE an
      // existing stamp rather than stripping it — otherwise a detached re-index
      // of the primary (e.g. CI's `actions/checkout` default) would un-claim the
      // flat slot and let the next branch analyze overwrite the primary index.
      // Stays absent only when never stamped (fresh detached/non-git repo).
      branch: branchLabel ?? existingMeta?.branch,
      // Captured here (not at registration) so it travels with the
      // on-disk meta.json — sibling-clone fingerprinting works for
      // out-of-tree consumers (group-status, future tooling) without
      // a second git shellout. `undefined` when the repo has no
      // origin remote, which is fine: paths-only repos behave as
      // before.
      remoteUrl: repositoryRemoteUrl,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      capabilities: {
        graph: { provider: 'ladybugdb', status: runtimeCapabilities.graph },
        // Reflect what this analyze run actually produced: when the FTS
        // extension was unavailable the indexes were skipped, so record
        // 'unavailable' rather than the static runtime default. Keeps
        // meta.json / `gitnexus doctor` honest about degraded search.
        fts: {
          provider: 'ladybugdb-fts',
          status: ftsAvailable ? runtimeCapabilities.fts : 'unavailable',
        },
        vectorSearch: {
          provider: effectiveSemanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
          status: embeddingCount > 0 ? effectiveSemanticMode : 'unavailable',
          exactScanLimit: runtimeCapabilities.exactScanLimit,
          reason: runtimeCapabilities.reason,
        },
      },
      // Schema identity is always stamped. Git-only fields below remain
      // conditional, so non-Git repositories still rebuild their graph while
      // staged embedding checkpoints remain distinguishable from legacy data.
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      // Always stamped with the live resolved mode (#2331/#2339) — unlike
      // `pdg` below, 'none' is a meaningful value to compare, not an
      // absence, so this is never conditionally omitted.
      cjkSegmentation: getSearchFTSCjkSegmentation(),
      fileHashes: hasGitDir(repoPath) ? newFileHashesRecord : undefined,
      // This branch's full live chunk-key set (#2106 R6). `usedKeys` is every
      // chunk hash touched in this scan — cache HITS included (see parse-impl
      // usedKeys.add) — so it's complete even on an incremental run. Persisted
      // so a sibling branch's prune can union it and not evict our shards.
      cacheKeys: [...parseCache.usedKeys],
      incrementalInProgress: undefined as RepoMeta['incrementalInProgress'],
      embeddingCheckpoint: undefined,
      // The effective pdg config this run's DB rows were built under
      // (#2099 F1). `undefined` on pdg-off runs — this meta is a fresh
      // literal (no spread of existingMeta), so omission is what CLEARS the
      // stamp after an on→off flip; the next pdgModeMismatch then compares
      // off==off and incremental eligibility is restored.
      pdg: resolvePdgConfig(options),
    });
    if (isIncremental && hashDiff) {
      callbacks.onRecoveryBoundary?.('before-finalize', {
        phase: escalatedFullWrite ? 'escalated-load-graph' : 'load-graph',
        targetCommit: currentCommit,
      });
    }
    const metadataToCommit = stagedPaths ? meta : markPendingImplicitFlatAdoption(meta);
    await saveMeta(metaDir, metadataToCommit);

    // Persist the incremental parse cache for the next run. Wraps in
    // try/catch so a cache-write failure never breaks an otherwise
    // successful indexing run. Prune stale chunk-hash entries first so
    // the cache file size stays bounded across runs (chunks whose
    // composition no longer matches anything in the current scan are
    // dead weight; the parse phase populates `usedKeys` as it processes
    // chunks).
    try {
      // #2106 R6: the parse cache + durable store are shared across branches.
      // Before pruning to this run's keys, fold in the OTHER branches' recorded
      // chunk keys so a branch switch doesn't evict their still-live shards.
      // Adding to usedKeys makes them survive pruneCache AND land in the saved
      // index (saveParseCache builds the index from usedKeys). Excludes this
      // run's own meta dir, so a single-branch repo folds in nothing → prune
      // set byte-identical to today.
      const { keys: siblingKeys, complete } = await collectBranchCacheKeys(storagePath, metaDir);
      if (complete) {
        for (const k of siblingKeys) parseCache.usedKeys.add(k);
      } else {
        // Fail-safe toward retention: a sibling meta was unreadable, so keep
        // everything currently loaded rather than evict on incomplete info.
        log('Parse cache: a branch meta was unreadable — retaining all cached chunks (#2106).');
        for (const k of parseCache.entries.keys()) parseCache.usedKeys.add(k);
      }
      const pruned = pruneCache(parseCache, parseCache.usedKeys);
      if (pruned > 0) {
        log(`Parse cache: pruned ${pruned} stale chunk entries`);
      }
      const savedKeys = await saveParseCache(storagePath, parseCache);
      // Prune the durable ParsedFile store to EXACTLY the parse cache's
      // surviving keys (#2038 warm-cache coverage), so the two content-addressed
      // stores stay coherent: a chunk is "cached" iff both its parse-cache shard
      // and its durable shards exist. A quarantined chunk (in usedKeys but with
      // no parse-cache shard) drops its durable subdir here and re-dispatches
      // next run. Same try/catch — a durable-store write failure must never
      // break an otherwise successful run (next run treats it as a miss).
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storagePath),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
    } catch (e) {
      log(`Warning: could not save parse cache (${(e as Error).message}); continuing.`);
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    // Stop the manual checkpoint driver before closeLbug so its
    // in-flight CHECKPOINT cannot race the `safeClose` CHECKPOINT.
    await walCheckpointDriver.stop();
    // CLI callers (about to process.exit) skip the native close to dodge a
    // LadybugDB destructor double-free after --pdg writes — closeLbugBeforeExit
    // CHECKPOINTs for durability then leaves the handles for process exit to
    // reclaim (#2264). Long-lived callers close for real.
    await (options.skipNativeCloseOnExit && !stagedPaths ? closeLbugBeforeExit() : closeLbug());

    let embeddingTableRebuildMarkerRemoved = true;
    if (embeddingTableRebuildStarted) {
      await removeEmbeddingTableRebuildMarker(embeddingTableRebuildMarkerPath).catch((error) => {
        embeddingTableRebuildMarkerRemoved = false;
        log(
          `Warning: could not remove completed embedding table rebuild marker ` +
            `(${(error as Error).message}); the validated snapshot remains authoritative.`,
        );
      });
    }
    if (embeddingSnapshotAvailable && embeddingTableRebuildMarkerRemoved) {
      await removeEmbeddingSnapshot(embeddingSnapshotPath).catch((error) => {
        log(
          `Warning: could not remove completed embedding preservation snapshot ` +
            `(${(error as Error).message}); it will be ignored unless its source identity matches.`,
        );
      });
    }

    // The staged DB is closed and checkpointed before validation. Promotion
    // retains the old canonical file as a backup until metadata + registry are
    // committed, so every crash boundary has at least one complete generation.
    let projectName: string;
    if (stagedPaths) {
      progress('lbug', 97, 'Validating staged generation...');
      progress('lbug', 99, 'Promoting staged generation...');
      const promotedProjectName = await promoteValidatedStage(stagedPaths);
      projectName =
        promotedProjectName ??
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath));
    } else {
      // Forward the --name alias and registry-collision bypass only after the
      // canonical DB is finalized. In staged mode this same commit is journaled.
      projectName = await registerRepo(persistedRepoPath, metadataToCommit, {
        name: options.registryName,
        allowDuplicateName: options.allowDuplicateName,
        branch: placement.branch,
        ...frozenRegistryIdentity,
      });
    }

    // ── #2354: the flat workspace slot has adopted this run's branch ──────
    if (implicitFlatBranch) {
      try {
        await adoptAndRestampImplicitFlatBranch(metadataToCommit);
      } catch (e) {
        log(
          `Warning: could not sync the workspace branch label (${(e as Error).message}); continuing.`,
        );
      }
    }

    // Side effects that describe the canonical generation happen only after a
    // staged promotion has committed.
    await ensureGitNexusIgnored(repoPath);

    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    if (!placement.branch) {
      try {
        await generateAIContextFiles(
          repoPath,
          storagePath,
          projectName,
          {
            files: pipelineResult.totalFileCount,
            nodes: stats.nodes,
            edges: stats.edges,
            communities: pipelineResult.communityResult?.stats.totalCommunities,
            clusters: aggregatedClusterCount,
            processes: pipelineResult.processResult?.stats.totalProcesses,
          },
          undefined,
          {
            skipAgentsMd: options.skipAgentsMd,
            skipSkills: options.skipSkills,
            noStats: options.noStats,
            defaultBranch: options.defaultBranch,
            hasPdg: options.pdg === true,
          },
        );
      } catch {
        // Best-effort — don't fail the entire analysis for context file issues
      }
    }

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
      ftsSkipped: !ftsAvailable,
      isPrimaryBranch: !placement.branch,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error. Stop the driver first
    // so its retry loop cannot extend an already-failing analyze.
    try {
      await walCheckpointDriver.stop();
    } catch {
      /* swallow — surface path is the rethrow below */
    }
    try {
      // Skip the native close on the error path too: a real conn.close() after
      // large --pdg writes can itself abort in LadybugDB's ClientContext
      // destructor (#2264 review P2), turning an actionable exit-1 into a raw
      // SIGABRT. closeLbugBeforeExit leaves the handles open, but the CLI catch
      // now force-exits when isLbugReady() (analyze.ts, #2264 review P1), so the
      // process still terminates — no hang, no abort. flushWAL keeps the partial
      // index durable; process exit reclaims the handles. Long-lived callers
      // (skipNativeCloseOnExit unset) close for real.
      await (options.skipNativeCloseOnExit && !stagedPaths ? closeLbugBeforeExit() : closeLbug());
    } catch {
      /* swallow */
    }
    throw err;
  }
};

type AnalyzeInternalContext = {
  /** The server parent owns the frozen storage/root lease through finalization. */
  parentAnalyzeOwnershipHeld?: boolean;
};

export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  internal: AnalyzeInternalContext = {},
): Promise<AnalyzeResult> {
  if (
    internal.parentAnalyzeOwnershipHeld &&
    (!options.analyzeStoragePath || !options.registryPath)
  ) {
    throw new Error(
      'Parent-held analyze ownership requires frozen analyzeStoragePath and registryPath.',
    );
  }
  if (
    options.registryPath !== undefined &&
    !registryPathEquals(canonicalizePath(options.registryPath), canonicalizePath(repoPath))
  ) {
    throw new Error('GitNexus: analyze display path changed before worker start');
  }
  if (options.analyzeStoragePath !== undefined && !path.isAbsolute(options.analyzeStoragePath)) {
    throw new Error('GitNexus: analyze storage target must be absolute');
  }
  if (options.incrementalOnly && options.dropEmbeddings) {
    throw new Error(
      'Cannot combine `--incremental-only` with `--drop-embeddings`. ' +
        'The preservation contract refuses every option that can require a clean rebuild.',
    );
  }
  if (options.repairVector) {
    const conflicts = [
      options.force && '--force',
      options.staged && '--staged',
      options.incrementalOnly && '--incremental-only',
      options.repairFts && '--repair-fts',
      options.embeddings && '--embeddings',
      options.embeddingsNodeLimit !== undefined && '--embeddings',
      options.dropEmbeddings && '--drop-embeddings',
      options.pdg && '--pdg',
      options.branch && '--branch',
    ].filter((value): value is string => typeof value === 'string');
    if (conflicts.length > 0) {
      throw new Error(`Cannot combine \`--repair-vector\` with ${conflicts.join(', ')}.`);
    }
  }

  // Repository identity is the first gate. It must run before the analyzer
  // ownership lock creates its storage directory, as well as before metadata,
  // sidecar, or database mutation. registerRepo repeats the check at commit
  // time for races and non-analyze callers.
  const repoHasGit = hasGitDir(repoPath);
  const repositoryRemoteUrl = repoHasGit ? getRemoteUrl(repoPath) : undefined;
  await assertCanonicalRepositoryIdentity(repoPath, repositoryRemoteUrl);
  if (options.repairVector) await assertVectorRepairPreflight(repoPath);

  const storagePath = options.analyzeStoragePath ?? getStoragePaths(repoPath).storagePath;
  const runWithOwnedStorage = async (): Promise<AnalyzeResult> => {
    // The first preflight avoids creating an ownership lock for a known-dirty
    // index. Repeat it after lock acquisition because a writer may have run
    // while this command was waiting and left new recovery or dirty state.
    if (options.repairVector) {
      await assertVectorRepairPreflight(repoPath, { allowAnalyzeOwnershipLock: true });
    }
    return runFullAnalysisImpl(repoPath, options, callbacks, {
      repoHasGit,
      remoteUrl: repositoryRemoteUrl,
    });
  };

  if (internal.parentAnalyzeOwnershipHeld) {
    return runWithOwnedStorage();
  }

  return withAnalyzeOwnershipLock(storagePath, runWithOwnedStorage, { repoRoot: repoPath });
}
