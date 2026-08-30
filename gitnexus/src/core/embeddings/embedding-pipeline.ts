/**
 * Embedding Pipeline Module
 *
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from LadybugDB
 * 2. Generate text representations with enriched metadata
 * 3. Chunk long nodes, batch embed
 * 4. Update LadybugDB with chunk-aware embeddings
 * 5. Create vector index for semantic search
 */

import { createHash } from 'crypto';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
  isEmbedderReady,
} from './embedder.js';
import { generateEmbeddingText } from './text-generator.js';
import { chunkNode, characterChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  EMBEDDABLE_LABELS,
  isShortLabel,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  STRUCTURAL_LABELS,
  collectBestChunks,
} from './types.js';
import {
  DEFAULT_VECTOR_MAX_DISTANCE,
  getVectorMaxDistance,
  resolveEmbeddingConfig,
} from './config.js';
import { rankExactEmbeddingRows, type ExactEmbeddingRow } from './exact-search.js';
import {
  EMBEDDING_TABLE_NAME,
  EMBEDDING_INDEX_NAME,
  EMBEDDING_DIMS,
  STALE_HASH_SENTINEL,
} from '../lbug/schema.js';
import {
  loadVectorExtension,
  createVectorIndex,
  dropVectorIndex,
  inspectEmbeddingIntegrity,
  embeddingIntegrityFailures,
} from '../lbug/lbug-adapter.js';
import { escapeCypherString } from '../lbug/cypher-escape.js';
import { isMissingColumnOrTableError } from '../lbug/schema-errors.js';
import type { ExtensionInstallPolicy } from '../lbug/extension-loader.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import { logger } from '../logger.js';

const isDev = process.env.NODE_ENV === 'development';

const vectorUnavailableMessage =
  'VECTOR extension unavailable; semantic embeddings fall back to exact scan. ' +
  'To enable vector search, install it once with network access ' +
  '(GITNEXUS_LBUG_EXTENSION_INSTALL=auto), or pre-install it for offline use. ' +
  'Set GITNEXUS_LBUG_EXTENSION_INSTALL=never to skip installs and silence this.';

/**
 * Resolve the extension-install policy for the embedding WRITE path (analyze).
 *
 * Generating embeddings is an explicit opt-in to a feature that requires the
 * VECTOR extension, so when the operator has NOT pinned a policy we default to
 * `auto` (one bounded, out-of-process INSTALL) — matching the documented
 * "auto = default for analyze" intent in extension-loader.ts. An explicit
 * GITNEXUS_LBUG_EXTENSION_INSTALL=load-only|never|auto always wins, so an
 * offline or locked-down operator is never silently forced onto the network
 * (the #1153 regression caused by hard-coding `auto` here). Read on every call
 * (not memoized) so test env stubbing works.
 */
export const resolveEmbeddingInstallPolicy = (): ExtensionInstallPolicy => {
  const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
  if (raw === 'load-only' || raw === 'never' || raw === 'auto') return raw;
  return 'auto';
};

const ensureVectorExtensionAvailable = async (): Promise<boolean> => {
  return loadVectorExtension(undefined, { policy: resolveEmbeddingInstallPolicy() });
};

const waitForOperationOrAbort = <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return operation;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const onAbort = () =>
      rejectOnce(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));

    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolveOnce, rejectOnce);
    if (signal.aborted) onAbort();
  });
};
/**
 * Bump this when the embedding text template changes in a way that should
 * invalidate existing vectors, such as metadata/header shape changes,
 * structural container context changes, or preceding-context formatting rules.
 */
export const EMBEDDING_TEXT_VERSION = 'v4';

/**
 * Compute a stable content fingerprint for an embeddable node.
 * Used to detect when the underlying text has changed so stale vectors
 * can be replaced (DELETE-then-INSERT, the Kuzu-sanctioned pattern for
 * vector-indexed rows).
 */
export const contentHashForNode = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  // Hash must be deterministic across runs, so exclude methodNames/fieldNames
  // which are populated during the batch loop via AST extraction.
  // Using only node.content ensures the hash stays stable.
  // NOTE: A change to extractStructuralNames behavior requires bumping EMBEDDING_TEXT_VERSION.
  const text = generateEmbeddingText(
    { ...node, methodNames: undefined, fieldNames: undefined },
    node.content,
    config,
  );
  return createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');
};

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

export const EMBEDDABLE_NODE_PAGE_SIZE = 512;
const MAX_EMBEDDING_BATCH_SIZE = 16;
const MAX_EMBEDDING_SUB_BATCH_SIZE = 8;

interface EmbeddableNodeRef {
  id: string;
  label: string;
}

const mapEmbeddableRow = (row: any, label: string): EmbeddableNode => {
  const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
  const content = row.content ?? row[4] ?? '';
  return {
    id: String(row.id ?? row[0] ?? ''),
    name: String(row.name ?? row[1] ?? ''),
    label: String(row.label ?? row[2] ?? label),
    filePath: String(row.filePath ?? row[3] ?? ''),
    content,
    startLine: label === 'File' ? 1 : (row.startLine ?? row[5]),
    endLine: label === 'File' ? Math.max(1, content.split('\n').length) : (row.endLine ?? row[6]),
    isExported: hasExportedColumn ? (row.isExported ?? row[7]) : undefined,
    description: row.description ?? (hasExportedColumn ? row[8] : row[7]),
    ...(label === LABEL_METHOD
      ? {
          parameterCount: row.parameterCount ?? row[9],
          returnType: row.returnType ?? row[10],
        }
      : {}),
  };
};

const buildEmbeddableNodeQuery = (
  label: string,
  selector: { afterId?: string; nodeIds?: readonly string[] },
): string => {
  const table = label === 'File' ? 'File' : `\`${label}\``;
  const where = selector.nodeIds
    ? `WHERE n.id IN [${selector.nodeIds.map((id) => `'${escapeCypherString(id)}'`).join(', ')}]`
    : selector.afterId
      ? `WHERE n.id > '${escapeCypherString(selector.afterId)}'`
      : '';
  const projection =
    label === 'File'
      ? `n.id AS id, n.name AS name, 'File' AS label, n.filePath AS filePath, n.content AS content`
      : label === LABEL_METHOD
        ? `n.id AS id, n.name AS name, 'Method' AS label,
           n.filePath AS filePath, n.content AS content,
           n.startLine AS startLine, n.endLine AS endLine,
           n.isExported AS isExported, n.description AS description,
           n.parameterCount AS parameterCount, n.returnType AS returnType`
        : LABELS_WITH_EXPORTED.has(label)
          ? `n.id AS id, n.name AS name, '${label}' AS label,
             n.filePath AS filePath, n.content AS content,
             n.startLine AS startLine, n.endLine AS endLine,
             n.isExported AS isExported, n.description AS description`
          : `n.id AS id, n.name AS name, '${label}' AS label,
             n.filePath AS filePath, n.content AS content,
             n.startLine AS startLine, n.endLine AS endLine,
             n.description AS description`;
  return `MATCH (n:${table}) ${where} RETURN ${projection} ORDER BY n.id LIMIT ${EMBEDDABLE_NODE_PAGE_SIZE}`;
};

const queryLabelNodePages = async function* (
  executeQuery: (cypher: string) => Promise<any[]>,
  label: string,
): AsyncGenerator<EmbeddableNode[]> {
  let afterId: string | undefined;
  for (;;) {
    const rows = await executeQuery(buildEmbeddableNodeQuery(label, { afterId }));
    if (!rows || rows.length === 0) return;
    const rawPage = rows.slice(0, EMBEDDABLE_NODE_PAGE_SIZE);
    const nextAfterId = String(rawPage.at(-1)?.id ?? rawPage.at(-1)?.[0] ?? '');
    if (!nextAfterId || (afterId !== undefined && nextAfterId <= afterId)) return;
    afterId = nextAfterId;
    const page = rawPage
      .map((row) => mapEmbeddableRow(row, label))
      .filter((node) =>
        label === 'File'
          ? Boolean(
              node.id &&
              node.filePath &&
              node.content.trim() &&
              node.content !== '[Binary file - content not stored]',
            )
          : Boolean(node.id),
      );
    if (page.length > 0) yield page;
    if (rows.length < EMBEDDABLE_NODE_PAGE_SIZE) return;
  }
};

/**
 * Page code-symbol nodes deterministically. If the repository has no code
 * symbols, page text-bearing File nodes instead.
 */
export const queryEmbeddableNodes = async function* (
  executeQuery: (cypher: string) => Promise<any[]>,
): AsyncGenerator<EmbeddableNode[]> {
  let sawCodeSymbol = false;
  for (const label of EMBEDDABLE_LABELS) {
    try {
      for await (const page of queryLabelNodePages(executeQuery, label)) {
        sawCodeSymbol = true;
        yield page;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (!isMissingColumnOrTableError(message)) throw error;
      if (isDev) logger.warn({ error }, `Query for ${label} nodes failed:`);
    }
  }
  if (!sawCodeSymbol) yield* queryFallbackFileNodes(executeQuery);
};

/** Static/documentation repository fallback, still bounded to 512 rows. */
const queryFallbackFileNodes = async function* (
  executeQuery: (cypher: string) => Promise<any[]>,
): AsyncGenerator<EmbeddableNode[]> {
  try {
    yield* queryLabelNodePages(executeQuery, 'File');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (!isMissingColumnOrTableError(message)) throw error;
    if (isDev) logger.warn({ error }, 'Fallback File-node embedding query failed:');
  }
};

const queryNodesByRefs = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  refs: readonly EmbeddableNodeRef[],
): Promise<EmbeddableNode[]> => {
  if (refs.length > EMBEDDABLE_NODE_PAGE_SIZE) {
    throw new Error(`Embeddable node page exceeds ${EMBEDDABLE_NODE_PAGE_SIZE}`);
  }
  const byLabel = new Map<string, EmbeddableNodeRef[]>();
  for (const ref of refs) {
    const labelRefs = byLabel.get(ref.label) ?? [];
    labelRefs.push(ref);
    byLabel.set(ref.label, labelRefs);
  }
  const byId = new Map<string, EmbeddableNode>();
  for (const [label, labelRefs] of byLabel) {
    const ids = labelRefs.map((ref) => ref.id);
    const wanted = new Set(ids);
    const rows = await executeQuery(buildEmbeddableNodeQuery(label, { nodeIds: ids }));
    for (const row of rows.slice(0, EMBEDDABLE_NODE_PAGE_SIZE)) {
      const node = mapEmbeddableRow(row, label);
      if (wanted.has(node.id)) byId.set(node.id, node);
    }
  }
  const nodes = refs
    .map((ref) => byId.get(ref.id))
    .filter((node): node is EmbeddableNode => !!node);
  if (nodes.length !== refs.length) {
    throw new Error('An embeddable node disappeared while its checkpoint window was active');
  }
  return nodes;
};

/**
 * Batch INSERT chunk-aware embeddings into CodeEmbedding table
 */
export const batchInsertEmbeddings = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  updates: Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    embedding: number[];
    contentHash?: string;
  }>,
): Promise<void> => {
  const identities = new Set<string>();
  for (const update of updates) {
    const nodeId = update.nodeId;
    const identity = `${nodeId}:${update.chunkIndex}`;
    if (
      typeof nodeId !== 'string' ||
      nodeId.trim().length === 0 ||
      !Number.isSafeInteger(update.chunkIndex) ||
      update.chunkIndex < 0 ||
      update.embedding.length !== EMBEDDING_DIMS ||
      update.embedding.some((value) => !Number.isFinite(value)) ||
      identities.has(identity)
    ) {
      throw new Error('Embedding batch contains an invalid or duplicate identity/vector.');
    }
    identities.add(identity);
  }
  const cypher = `CREATE (e:${EMBEDDING_TABLE_NAME} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`;
  const paramsList = updates.map((u) => ({
    id: `${u.nodeId}:${u.chunkIndex}`,
    nodeId: u.nodeId,
    chunkIndex: u.chunkIndex,
    startLine: u.startLine,
    endLine: u.endLine,
    embedding: u.embedding,
    contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
  }));
  // Preserved malformed artifacts passed through the repeated prepared-CREATE
  // path, although a focused native reproduction did not prove it causal.
  // Prepare, execute, and drain once per identity as a bounded precaution; the
  // terminal integrity scan remains the authoritative safety gate.
  for (const params of paramsList) {
    await executeWithReusedStatement(cypher, [params]);
  }
};

/**
 * Create the vector index for semantic search (indexes the CodeEmbedding table).
 *
 * Keeps the embedding-specific extension-install policy gate here
 * (ensureVectorExtensionAvailable → resolveEmbeddingInstallPolicy, default
 * `auto` for the analyze write path), then delegates the actual
 * `CALL CREATE_VECTOR_INDEX(...)` to the adapter, which runs it through the
 * unprepared `conn.query()` path. It must NOT go through the injected
 * `executeQuery` (prepared `conn.prepare()`): LadybugDB cannot prepare that
 * procedure and fails with "We do not support prepare multiple statements" —
 * the silent degrade in #2114.
 *
 * Exported for run-analyze's wipe-and-restore seam (tri-review 4669518496
 * P1): a full-rebuild/escalated write wipes the DB files — index included —
 * and a preserve-only run restores embedding ROWS without ever reaching the
 * pipeline call sites below, so the orchestrator recreates the index through
 * this same policy-gated, warn-on-failure entry point. Consumed there via
 * dynamic import only (lazy-embeddings convention, #2370).
 */
export const buildVectorIndex = async (): Promise<boolean> => {
  const integrity = await inspectEmbeddingIntegrity(undefined, true);
  if (embeddingIntegrityFailures(integrity) > 0 || integrity.physicalRows !== integrity.validRows) {
    throw new Error(
      `Vector index creation refused malformed embedding rows ` +
        `(physical=${integrity.physicalRows}, valid=${integrity.validRows}, ` +
        `recoverable=${integrity.recoverableRows}).`,
    );
  }
  // This pre-check applies the embedding-specific install policy
  // (resolveEmbeddingInstallPolicy, default `auto` for analyze) before reaching
  // the adapter. The adapter's createVectorIndex() calls loadVectorExtension()
  // again, but that's a no-op here: once this gate loads VECTOR the module-level
  // `vectorExtensionLoaded` flag is set, so the adapter's second call
  // short-circuits without re-resolving the policy — no double install.
  if (!(await ensureVectorExtensionAvailable())) return false;
  try {
    return await createVectorIndex();
  } catch (error) {
    // Surface this even outside dev: it silently downgrades a user-requested
    // feature (semantic search) to exact scan. Log under `err` so pino's
    // standard serializer captures the message/stack — logging under `error`
    // serialized an Error to `{}` (the empty `{"error":{}}` reported in #2114).
    logger.warn(
      { err: error },
      'Vector index creation failed; semantic search will use exact-scan fallback',
    );
    return false;
  }
};

export interface EmbeddingPipelineResult {
  nodesProcessed: number;
  chunksProcessed: number;
  vectorIndexReady: boolean;
  semanticMode: 'vector-index' | 'exact-scan';
}

export interface EmbeddingPipelineCheckpoint {
  nodesProcessed: number;
  totalNodes: number;
  chunksProcessed: number;
}

export interface EmbeddingPipelineCheckpointWindow extends EmbeddingPipelineCheckpoint {
  nodeIds: string[];
}

export interface EmbeddingPipelineOptions {
  signal?: AbortSignal;
  checkpointEveryNodes?: number;
  forceReembedNodeIds?: ReadonlySet<string>;
  /** Exact known row identities, keyed by owner node, for PK-safe stale deletion. */
  existingEmbeddingRowIds?: ReadonlyMap<string, readonly string[]>;
  /** Drop staged HNSW before a checkpoint-window rewrite; rebuilt after inserts. */
  rebuildVectorIndexBeforeMutation?: boolean;
  /** Load cached node identities for one page; callers must return at most the requested IDs. */
  loadExistingEmbeddingHashes?: (
    nodeIds: readonly string[],
  ) => Promise<Map<string, string> | undefined>;
  onCheckpointWindowStart?: (window: EmbeddingPipelineCheckpointWindow) => Promise<void>;
  onCheckpoint?: (checkpoint: EmbeddingPipelineCheckpoint) => Promise<void>;
}

/**
 * DELETE stale embedding rows for the given nodeIds so they can be re-inserted.
 *
 * Kuzu forbids SET on vector-indexed properties; DELETE-then-INSERT is the
 * sanctioned pattern. A `"does not exist"` error means the rows are already gone
 * (safe to proceed); any other error risks vector-index corruption, so it
 * propagates and aborts the pipeline.
 *
 * Called per-batch (just before each batch's INSERT), not once up front — see
 * the caller comment / KTD7: an up-front bulk delete of every stale row leaves
 * the whole index deleted-not-reinserted if the re-embed is interrupted. Per-batch
 * interleaving bounds that window to a single batch.
 */
const deleteStaleEmbeddingRows = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  nodeIds: string[],
  existingEmbeddingRowIds?: ReadonlyMap<string, readonly string[]>,
): Promise<void> => {
  if (nodeIds.length === 0) return;
  try {
    const exactRowIds: string[] = [];
    const fallbackNodeIds: string[] = [];
    for (const nodeId of nodeIds) {
      const rowIds = existingEmbeddingRowIds?.get(nodeId);
      if (rowIds && rowIds.length > 0) exactRowIds.push(...rowIds);
      else fallbackNodeIds.push(nodeId);
    }
    if (exactRowIds.length > 0) {
      await executeWithReusedStatement(
        `MATCH (e:${EMBEDDING_TABLE_NAME} {id: $id}) DELETE e`,
        [...new Set(exactRowIds)].map((id) => ({ id })),
      );
    }
    if (fallbackNodeIds.length > 0) {
      await executeWithReusedStatement(
        `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId}) DELETE e`,
        fallbackNodeIds.map((nodeId) => ({ nodeId })),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('does not exist')) {
      throw new Error(
        `[embed] Failed to delete stale embedding rows — aborting to prevent vector-index corruption: ${msg}`,
      );
    }
  }
};

/**
 * Run the embedding pipeline
 *
 * @param executeQuery - Function to execute Cypher queries against LadybugDB
 * @param executeWithReusedStatement - Function to execute with reused prepared statement
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param skipNodeIds - Optional set of node IDs that already have embeddings (incremental mode)
 * @param existingEmbeddings - Optional map of nodeId → contentHash for incremental mode.
 *        Nodes whose hash matches are skipped; nodes with a changed hash are DELETE'd
 *        and re-embedded; nodes not in the map are embedded fresh.
 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  skipNodeIds?: Set<string>,
  existingEmbeddings?: Map<string, string>,
  pipelineOptions: EmbeddingPipelineOptions = {},
): Promise<EmbeddingPipelineResult> => {
  const finalConfig = resolveEmbeddingConfig(config);
  let totalChunks = 0;
  const checkpointEveryNodes = pipelineOptions.checkpointEveryNodes ?? 5_000;
  if (!Number.isSafeInteger(checkpointEveryNodes) || checkpointEveryNodes <= 0) {
    throw new Error('checkpointEveryNodes must be a positive integer');
  }
  const throwIfCancelled = (): void => pipelineOptions.signal?.throwIfAborted();

  try {
    throwIfCancelled();
    const vectorAvailable = await ensureVectorExtensionAvailable();
    throwIfCancelled();
    if (!vectorAvailable) {
      logger.warn(vectorUnavailableMessage);
    }
    if (pipelineOptions.rebuildVectorIndexBeforeMutation) {
      if (
        !vectorAvailable ||
        !(await dropVectorIndex({ policy: resolveEmbeddingInstallPolicy() }))
      ) {
        throw new Error(
          'Cannot safely resume the staged embedding checkpoint because its VECTOR index could not be dropped.',
        );
      }
      throwIfCancelled();
    }

    // Phase 1: Load embedding model
    onProgress({
      phase: 'loading-model',
      percent: 0,
      modelDownloadPercent: 0,
    });

    if (!isEmbedderReady()) {
      await waitForOperationOrAbort(
        initEmbedder((modelProgress: ModelProgress) => {
          const downloadPercent = modelProgress.progress ?? 0;
          onProgress({
            phase: 'loading-model',
            percent: Math.round(downloadPercent * 0.2),
            modelDownloadPercent: downloadPercent,
          });
        }, finalConfig),
        pipelineOptions.signal,
      );
      throwIfCancelled();
    }

    onProgress({
      phase: 'loading-model',
      percent: 20,
      modelDownloadPercent: 100,
    });

    if (isDev) {
      logger.info('🔍 Querying embeddable nodes...');
    }

    // Phase 2: scan bounded node pages and stream cached identity lookups. The
    // first pass computes an exact progress total without retaining node content;
    // the second pass builds one durable 5,000-node checkpoint window at a time.
    const forceReembedNodeIds = pipelineOptions.forceReembedNodeIds;
    const removedPendingNodeIds = new Set(forceReembedNodeIds ?? []);

    const loadPageHashes = async (
      nodes: readonly EmbeddableNode[],
    ): Promise<Map<string, string>> => {
      if (pipelineOptions.loadExistingEmbeddingHashes) {
        return (
          (await pipelineOptions.loadExistingEmbeddingHashes(nodes.map((node) => node.id))) ??
          new Map()
        );
      }
      if (!existingEmbeddings || existingEmbeddings.size === 0) return new Map();
      const page = new Map<string, string>();
      for (const node of nodes) {
        const hash = existingEmbeddings.get(node.id);
        if (hash !== undefined) page.set(node.id, hash);
      }
      return page;
    };

    const selectPageRefs = async (
      nodes: readonly EmbeddableNode[],
      trackPendingPresence: boolean,
    ): Promise<EmbeddableNodeRef[]> => {
      const existingHashes = await loadPageHashes(nodes);
      const selected: EmbeddableNodeRef[] = [];
      for (const node of nodes) {
        if (trackPendingPresence) removedPendingNodeIds.delete(node.id);
        const existingHash = existingHashes.get(node.id);
        if (
          existingHash === undefined ||
          existingHash !== contentHashForNode(node, finalConfig) ||
          forceReembedNodeIds?.has(node.id)
        ) {
          selected.push({ id: node.id, label: node.label });
        }
      }
      return selected;
    };

    let totalNodes = 0;
    for await (const page of queryEmbeddableNodes(executeQuery)) {
      throwIfCancelled();
      totalNodes += (await selectPageRefs(page, true)).length;
    }

    if (removedPendingNodeIds.size > 0) {
      await deleteStaleEmbeddingRows(
        executeWithReusedStatement,
        [...removedPendingNodeIds],
        pipelineOptions.existingEmbeddingRowIds,
      );
      throwIfCancelled();
    }

    if (isDev) {
      logger.info(`📊 Found ${totalNodes} embeddable nodes`);
    }

    if (totalNodes === 0) {
      throwIfCancelled();
      // Ensure the vector index exists even when no new nodes need embedding.
      // A prior crash or first-time incremental run may have left CodeEmbedding
      // rows without ever reaching index creation.
      const vectorIndexReady = await buildVectorIndex();

      onProgress({
        phase: 'ready',
        percent: 100,
        nodesProcessed: 0,
        totalNodes: 0,
      });
      return {
        nodesProcessed: 0,
        chunksProcessed: 0,
        vectorIndexReady,
        semanticMode: vectorIndexReady ? 'vector-index' : 'exact-scan',
      };
    }

    // Phase 3: Chunk + embed nodes
    const batchSize = Math.min(finalConfig.batchSize, MAX_EMBEDDING_BATCH_SIZE);
    const chunkSize = finalConfig.chunkSize;
    const overlap = finalConfig.overlap;
    const checkpointWindowNodeCount = checkpointEveryNodes;
    let processedNodes = 0;

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches: Math.ceil(totalNodes / batchSize),
    });

    const processNodePage = async (nodes: EmbeddableNode[]): Promise<void> => {
      const pageHashes = await loadPageHashes(nodes);
      for (let batchIndex = 0; batchIndex < nodes.length; batchIndex += batchSize) {
        throwIfCancelled();
        const batch = nodes.slice(batchIndex, batchIndex + batchSize);
        const allTexts: string[] = [];
        const allUpdates: Array<{
          nodeId: string;
          chunkIndex: number;
          startLine: number;
          endLine: number;
          contentHash: string;
        }> = [];

        for (const node of batch) {
          const isShort = isShortLabel(node.label);
          const startLine = node.startLine ?? 0;
          const endLine = node.endLine ?? 0;
          if (!isShort && STRUCTURAL_LABELS.has(node.label)) {
            try {
              const names = await extractStructuralNames(node.content, node.filePath);
              node.methodNames = names.methodNames;
              node.fieldNames = names.fieldNames;
            } catch {
              // AST extraction failed — names stay undefined, text-generator handles gracefully
            }
          }

          const hash = contentHashForNode(node, finalConfig);
          let chunks: Array<{
            text: string;
            chunkIndex: number;
            startLine: number;
            endLine: number;
          }>;
          if (isShort) {
            chunks = [{ text: node.content, chunkIndex: 0, startLine, endLine }];
          } else {
            try {
              chunks = await chunkNode(
                node.label,
                node.content,
                node.filePath,
                startLine,
                endLine,
                chunkSize,
                overlap,
              );
            } catch (chunkErr) {
              if (isDev) {
                logger.warn(
                  { chunkErr },
                  `⚠️ AST chunking failed for ${node.label} "${node.name}" (${node.filePath}), falling back to character-based chunking:`,
                );
              }
              chunks = characterChunk(node.content, startLine, endLine, chunkSize, overlap);
            }
          }

          let prevTail = '';
          for (const chunk of chunks) {
            allTexts.push(
              generateEmbeddingText(node, chunk.text, finalConfig, chunk.chunkIndex, prevTail),
            );
            allUpdates.push({
              nodeId: node.id,
              chunkIndex: chunk.chunkIndex,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              contentHash: hash,
            });
            prevTail = overlap > 0 ? chunk.text.slice(-overlap) : '';
          }
        }

        const batchStaleIds = batch
          .filter(
            (node) =>
              pageHashes.has(node.id) || pipelineOptions.existingEmbeddingRowIds?.has(node.id),
          )
          .map((node) => node.id);
        await deleteStaleEmbeddingRows(
          executeWithReusedStatement,
          batchStaleIds,
          pipelineOptions.existingEmbeddingRowIds,
        );
        throwIfCancelled();

        const embedSubBatch = Math.min(finalConfig.subBatchSize, MAX_EMBEDDING_SUB_BATCH_SIZE);
        for (let si = 0; si < allTexts.length; si += embedSubBatch) {
          const subTexts = allTexts.slice(si, si + embedSubBatch);
          const subUpdates = allUpdates.slice(si, si + embedSubBatch);
          let embeddings: Float32Array[];
          try {
            embeddings = await embedBatch(subTexts, { signal: pipelineOptions.signal });
          } catch (embedErr) {
            logger.error(
              { embedErr },
              `❌ embedBatch failed for ${subTexts.length} texts (first: "${subTexts[0]?.substring(0, 80)}..."):`,
            );
            throw embedErr;
          }
          await batchInsertEmbeddings(
            executeWithReusedStatement,
            subUpdates.map((update, index) => ({
              ...update,
              embedding: embeddingToArray(embeddings[index]),
            })),
          );
          throwIfCancelled();
        }

        processedNodes += batch.length;
        totalChunks += allUpdates.length;
        onProgress({
          phase: 'embedding',
          percent: Math.round(20 + (processedNodes / totalNodes) * 70),
          nodesProcessed: processedNodes,
          totalNodes,
          currentBatch: Math.ceil(processedNodes / batchSize),
          totalBatches: Math.ceil(totalNodes / batchSize),
        });
      }
    };

    const processCheckpointWindow = async (refs: EmbeddableNodeRef[]): Promise<void> => {
      if (pipelineOptions.onCheckpointWindowStart) {
        await pipelineOptions.onCheckpointWindowStart({
          nodesProcessed: processedNodes,
          totalNodes,
          chunksProcessed: totalChunks,
          nodeIds: refs.map((ref) => ref.id),
        });
        throwIfCancelled();
      }
      for (let i = 0; i < refs.length; i += EMBEDDABLE_NODE_PAGE_SIZE) {
        const pageRefs = refs.slice(i, i + EMBEDDABLE_NODE_PAGE_SIZE);
        await processNodePage(await queryNodesByRefs(executeQuery, pageRefs));
      }
      if (pipelineOptions.onCheckpoint) {
        await pipelineOptions.onCheckpoint({
          nodesProcessed: processedNodes,
          totalNodes,
          chunksProcessed: totalChunks,
        });
        throwIfCancelled();
      }
    };

    let checkpointRefs: EmbeddableNodeRef[] = [];
    for await (const page of queryEmbeddableNodes(executeQuery)) {
      throwIfCancelled();
      const selected = await selectPageRefs(page, false);
      for (const ref of selected) {
        checkpointRefs.push(ref);
        if (checkpointRefs.length === checkpointWindowNodeCount) {
          await processCheckpointWindow(checkpointRefs);
          checkpointRefs = [];
        }
      }
    }
    if (checkpointRefs.length > 0) await processCheckpointWindow(checkpointRefs);

    // Phase 4: Create vector index
    throwIfCancelled();
    onProgress({
      phase: 'indexing',
      percent: 90,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      logger.info('📇 Creating vector index...');
    }

    const vectorIndexReady = await buildVectorIndex();

    onProgress({
      phase: 'ready',
      percent: 100,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      logger.info(
        `✅ Embedding pipeline complete! (${totalChunks} chunks from ${totalNodes} nodes)`,
      );
    }
    return {
      nodesProcessed: totalNodes,
      chunksProcessed: totalChunks,
      vectorIndexReady,
      semanticMode: vectorIndexReady ? 'vector-index' : 'exact-scan',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isDev) {
      logger.error({ error }, '❌ Embedding pipeline error:');
    }

    onProgress({
      phase: 'error',
      percent: 0,
      error: errorMessage,
    });

    throw error;
  }
};

/**
 * Perform semantic search using the vector index with chunk deduplication
 */
export const semanticSearch = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 10,
  maxDistance: number = getVectorMaxDistance(DEFAULT_VECTOR_MAX_DISTANCE),
): Promise<SemanticSearchResult[]> => {
  if (!isEmbedderReady()) {
    throw new Error('Embedding model not initialized. Run embedding pipeline first.');
  }

  const queryEmbedding = await embedText(query);
  const queryVec = embeddingToArray(queryEmbedding);
  const queryVecStr = `[${queryVec.join(',')}]`;

  let bestChunks = new Map<
    string,
    { distance: number; chunkIndex: number; startLine: number; endLine: number }
  >();
  // Query/read path: NEVER spawn a network INSTALL on a user query. If the
  // VECTOR extension was not pre-installed, fall back to exact scan rather than
  // blocking the query on a download (offline-first; see extension-loader.ts
  // "load-only" — used by all serve/MCP query paths).
  if (await loadVectorExtension(undefined, { policy: 'load-only' })) {
    try {
      bestChunks = await collectBestChunks(k, async (fetchLimit) => {
        const vectorQuery = `
          CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
            CAST(${queryVecStr} AS FLOAT[${queryVec.length}]), ${fetchLimit})
          YIELD node AS emb, distance
          WITH emb, distance
          WHERE distance < ${maxDistance}
          RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                 emb.startLine AS startLine, emb.endLine AS endLine, distance
          ORDER BY distance
        `;

        const embResults = await executeQuery(vectorQuery);
        return embResults.map((row) => ({
          nodeId: row.nodeId ?? row[0],
          chunkIndex: row.chunkIndex ?? row[1] ?? 0,
          startLine: row.startLine ?? row[2] ?? 0,
          endLine: row.endLine ?? row[3] ?? 0,
          distance: row.distance ?? row[4],
        }));
      });
    } catch (error) {
      bestChunks = new Map();
      logger.warn(
        { err: error },
        'VECTOR index query failed; semantic search is using exact-scan fallback',
      );
    }
  }

  if (bestChunks.size === 0) {
    const countRows = await executeQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
    );
    const countRow = countRows[0];
    const embeddingCount = Number(countRow?.cnt ?? countRow?.[0] ?? 0);
    const exactLimit = getExactScanLimit();
    if (embeddingCount > 0 && embeddingCount <= exactLimit) {
      const rows = await executeQuery(`
        MATCH (e:${EMBEDDING_TABLE_NAME})
        RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
               e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding
      `);
      const exactRows: ExactEmbeddingRow[] = rows.map((row) => ({
        nodeId: row.nodeId ?? row[0],
        chunkIndex: row.chunkIndex ?? row[1] ?? 0,
        startLine: row.startLine ?? row[2] ?? 0,
        endLine: row.endLine ?? row[3] ?? 0,
        embedding: row.embedding ?? row[4] ?? [],
      }));
      bestChunks = new Map(
        rankExactEmbeddingRows(exactRows, queryVec, k, maxDistance).map((row) => [
          row.nodeId,
          {
            distance: row.distance,
            chunkIndex: row.chunkIndex,
            startLine: row.startLine,
            endLine: row.endLine,
          },
        ]),
      );
    } else if (embeddingCount > exactLimit) {
      logger.warn(
        `Semantic exact scan refused: ${embeddingCount} chunks exceed the configured safety limit of ${exactLimit}. Restore the VECTOR index or deliberately raise GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT after reviewing memory cost.`,
      );
    }
  }

  if (bestChunks.size === 0) {
    return [];
  }

  // Group results by label for batched metadata queries
  const byLabel = new Map<
    string,
    Array<{ nodeId: string; distance: number } & Record<string, any>>
  >();
  for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, k)) {
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ nodeId, ...chunk });
  }

  // Batch-fetch metadata per label
  const results: SemanticSearchResult[] = [];

  for (const [label, items] of byLabel) {
    const idList = items.map((i) => `'${escapeCypherString(i.nodeId)}'`).join(', ');
    try {
      const nodeQuery = `
        MATCH (n:\`${label}\`) WHERE n.id IN [${idList}]
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine
      `;
      const nodeRows = await executeQuery(nodeQuery);
      const rowMap = new Map<string, any>();
      for (const row of nodeRows) {
        const id = row.id ?? row[0];
        rowMap.set(id, row);
      }
      for (const item of items) {
        const nodeRow = rowMap.get(item.nodeId);
        if (nodeRow) {
          results.push({
            nodeId: item.nodeId,
            name: nodeRow.name ?? nodeRow[1] ?? '',
            label,
            filePath: nodeRow.filePath ?? nodeRow[2] ?? '',
            distance: item.distance,
            startLine: item.startLine,
            endLine: item.endLine,
          });
        }
      }
    } catch {
      // Table might not exist, skip
    }
  }

  results.sort((a, b) => a.distance - b.distance);

  return results;
};

/**
 * Semantic search with graph expansion (flattened results)
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 5,
  _hops: number = 1,
): Promise<any[]> => {
  const results = await semanticSearch(executeQuery, query, k);

  return results.map((r) => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
