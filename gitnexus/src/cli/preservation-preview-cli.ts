import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeEmbeddingDims } from './embedding-dims.js';
import {
  executeQuery,
  scanEmbeddingPreservationRows,
  type EmbeddingPreservationRow,
  withLbugReadOnlyNonRecovering,
} from '../core/lbug/lbug-adapter.js';
import {
  buildEmbeddingPreservationPreviewFromNodes,
  type PreservationPreviewBase,
} from '../core/embeddings/preservation-preview.js';
import {
  PRESERVATION_PLAN_SCHEMA,
  PRESERVATION_PLANNER_VERSION,
} from '../core/embeddings/preservation-plan.js';
import { httpEmbeddingProvider } from '../core/embeddings/embedding-identity.js';
import {
  DEFAULT_EMBEDDING_CONFIG,
  isShortLabel,
  type EmbeddableNode,
} from '../core/embeddings/types.js';
import type { Chunk } from '../core/embeddings/chunker.js';
import { canonicalizePath, getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { getCurrentBranch, getCurrentCommit, getGitRoot } from '../storage/git.js';
import type { PreservationPlan } from '../core/embeddings/preservation-plan.js';

export interface PreservationPreviewCliOptions extends Record<string, unknown> {
  preserveVerifiedEmbeddings?: boolean;
  dryRun?: boolean;
  json?: boolean;
  staged?: boolean;
  embeddings?: boolean | string;
  skipGit?: boolean;
  branch?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingAuthToken?: string;
  embeddingDims?: string;
  planDigest?: string;
  maxReembedNodes?: string;
  force?: boolean;
  dropEmbeddings?: boolean;
  repairFts?: boolean;
  repairVector?: boolean;
}

type ChunkNode = (
  label: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize?: number,
  overlap?: number,
) => Promise<Chunk[]>;

/** Match the production embedding pipeline's exact chunk-index admission rule. */
export const derivePreservationChunkIndices = async (
  node: EmbeddableNode,
  chunkNodeForNode: ChunkNode,
): Promise<number[]> => {
  if (isShortLabel(node.label)) return [0];
  const startLine = Number.isSafeInteger(node.startLine) ? Number(node.startLine) : 1;
  const endLine = Number.isSafeInteger(node.endLine) ? Number(node.endLine) : 1;
  return (await chunkNodeForNode(node.label, node.content, node.filePath, startLine, endLine)).map(
    ({ chunkIndex }) => chunkIndex,
  );
};

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const sha256File = async (filePath: string): Promise<string> => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
};

const fail = (message: string): void => {
  process.stderr.write(`  Preservation preview refused: ${message}\n`);
  process.exitCode = 1;
};

const resolveRepoPath = (inputPath: string | undefined, skipGit: boolean): string => {
  if (inputPath) return canonicalizePath(path.resolve(inputPath));
  if (skipGit) return canonicalizePath(process.cwd());
  const root = getGitRoot(process.cwd());
  if (!root) throw new Error('not inside a Git repository; pass a path or --skip-git');
  return canonicalizePath(root);
};

const resolveEmbeddingIdentity = (
  options: PreservationPreviewCliOptions,
  textVersion: string,
): PreservationPreviewBase['embedding'] & {
  costAdmission: 'local-zero' | 'external-price-required';
} => {
  const endpoint = options.embeddingBaseUrl ?? process.env.GITNEXUS_EMBEDDING_URL;
  const model = options.embeddingModel ?? process.env.GITNEXUS_EMBEDDING_MODEL;
  const rawDimensions = options.embeddingDims ?? process.env.GITNEXUS_EMBEDDING_DIMS;
  const dimensions = rawDimensions
    ? Number(normalizeEmbeddingDims(String(rawDimensions)))
    : DEFAULT_EMBEDDING_CONFIG.dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error('embedding dimensions must be a positive integer');
  }
  if (Boolean(endpoint) !== Boolean(model)) {
    throw new Error('HTTP preview requires both embedding endpoint and model');
  }
  if (endpoint && model) {
    return {
      provider: httpEmbeddingProvider(endpoint),
      transport: 'http',
      model,
      dimensions,
      textVersion,
      costAdmission: 'external-price-required',
    };
  }
  return {
    provider: 'local',
    transport: 'onnx',
    model: DEFAULT_EMBEDDING_CONFIG.modelId,
    dimensions,
    textVersion,
    costAdmission: 'local-zero',
  };
};

const validatePreviewOptions = (options: PreservationPreviewCliOptions): void => {
  if (!options.preserveVerifiedEmbeddings || !options.dryRun || !options.json) {
    throw new Error('preview requires --preserve-verified-embeddings --dry-run --json');
  }
  if (!options.staged || options.embeddings === undefined || options.embeddings === false) {
    throw new Error('preview requires --staged and --embeddings');
  }
  if (options.planDigest !== undefined || options.maxReembedNodes !== undefined) {
    throw new Error('--plan-digest and --max-reembed-nodes are apply-only');
  }
  if (options.embeddingAuthToken !== undefined) {
    throw new Error('--embedding-auth-token is not accepted by provider-free preview');
  }
  if (options.force || options.dropEmbeddings || options.repairFts || options.repairVector) {
    throw new Error('preview cannot be combined with force, drop, or repair flags');
  }
};

export interface PreservationPlanContext {
  plan: PreservationPlan;
  acceptedRows: EmbeddingPreservationRow[];
  meta: NonNullable<Awaited<ReturnType<typeof loadMeta>>>;
  repoPath: string;
  currentCommit: string;
  currentBranch: string;
  storage: ReturnType<typeof getStoragePaths>;
  costAdmission: 'local-zero' | 'external-price-required';
}

export const computePreservationPlan = async (
  inputPath: string | undefined,
  options: PreservationPreviewCliOptions,
): Promise<PreservationPlanContext> => {
  const repoPath = resolveRepoPath(inputPath, options.skipGit === true);
  const currentCommit = getCurrentCommit(repoPath);
  if (!currentCommit) throw new Error('source commit identity is unavailable');
  const currentBranch = getCurrentBranch(repoPath);
  if (!currentBranch) throw new Error('source branch identity is unavailable');
  if (options.branch !== undefined && options.branch !== currentBranch)
    throw new Error('requested branch differs from the checked-out branch');

  const storage = getStoragePaths(repoPath, options.branch);
  const metaDir = path.dirname(storage.metaPath);
  const meta = await loadMeta(metaDir);
  if (!meta) throw new Error('canonical metadata is missing or unreadable');
  if (meta.incrementalInProgress) throw new Error('an interrupted analysis marker is present');
  if ((meta.embeddingCheckpoint?.pendingNodeIds?.length ?? 0) > 0) {
    throw new Error('an embedding checkpoint is pending');
  }
  if (canonicalizePath(meta.repoPath) !== repoPath) {
    throw new Error('metadata repository identity does not match the requested worktree');
  }
  if (meta.lastCommit !== currentCommit)
    throw new Error('source HEAD differs from the indexed commit');
  if (meta.branch !== undefined && meta.branch !== currentBranch) {
    throw new Error('metadata branch differs from the requested branch');
  }

  const metadataBytes = await fs.readFile(storage.metaPath);
  const databaseSha256 = await sha256File(storage.lbugPath);
  const { queryEmbeddableNodes, contentHashForNode, EMBEDDING_TEXT_VERSION } =
    await import('../core/embeddings/embedding-pipeline.js');
  const identity = resolveEmbeddingIdentity(options, EMBEDDING_TEXT_VERSION);
  const expectedCheckpoint = meta.embeddingCheckpoint;
  if (
    expectedCheckpoint?.provider === undefined ||
    expectedCheckpoint.provider !== identity.provider ||
    expectedCheckpoint.model !== identity.model ||
    expectedCheckpoint.dimensions !== identity.dimensions
  ) {
    throw new Error('metadata does not prove the requested provider, model, and dimensions');
  }

  const acceptedRows: EmbeddingPreservationRow[] = [];
  const nodes: EmbeddableNode[] = [];
  const plan = await withLbugReadOnlyNonRecovering(storage.lbugPath, async () => {
    const scan = await scanEmbeddingPreservationRows({
      onBatch: (batch) => {
        acceptedRows.push(...batch);
      },
    });
    const { chunkNode } = await import('../core/embeddings/chunker.js');
    for await (const page of queryEmbeddableNodes(executeQuery)) nodes.push(...page);
    return buildEmbeddingPreservationPreviewFromNodes({
      base: {
        schemaVersion: PRESERVATION_PLAN_SCHEMA,
        plannerVersion: PRESERVATION_PLANNER_VERSION,
        source: { head: currentCommit, branch: currentBranch, worktree: repoPath },
        storage: {
          database: { canonicalPath: canonicalizePath(storage.lbugPath), sha256: databaseSha256 },
          metadata: {
            canonicalPath: canonicalizePath(storage.metaPath),
            sha256: sha256(metadataBytes),
          },
        },
        embedding: identity,
      },
      scan,
      acceptedRows,
      nodes,
      derivation: {
        chunkIndicesForNode: (node) => derivePreservationChunkIndices(node, chunkNode),
        contentHashForNode,
      },
    });
  });
  return {
    plan,
    acceptedRows,
    meta,
    repoPath,
    currentCommit,
    currentBranch,
    storage,
    costAdmission: identity.costAdmission,
  };
};

export const preservationPreviewCommand = async (
  inputPath?: string,
  rawOptions?: Record<string, unknown>,
): Promise<void> => {
  const options = (rawOptions ?? {}) as PreservationPreviewCliOptions;
  const priorOrtLogLevel = process.env.ORT_LOG_LEVEL;
  try {
    validatePreviewOptions(options);
    const { plan, costAdmission } = await computePreservationPlan(inputPath, options);

    process.stdout.write(
      `${JSON.stringify({
        ...plan,
        costAdmission,
        estimatedCostUsd: costAdmission === 'local-zero' ? 0 : null,
      })}\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (priorOrtLogLevel === undefined) delete process.env.ORT_LOG_LEVEL;
    else process.env.ORT_LOG_LEVEL = priorOrtLogLevel;
  }
};
