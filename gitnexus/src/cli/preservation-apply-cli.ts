import path from 'node:path';
import {
  executeQuery,
  executeWithReusedStatement,
  inspectEmbeddingIntegrity,
  recreateCodeEmbeddingTable,
  scanEmbeddingPreservationRows,
  withLbugDb,
} from '../core/lbug/lbug-adapter.js';
import { assertEmbeddingIntegrity } from '../core/embeddings/checkpoint-identity.js';
import { executePreservationApply } from '../core/embeddings/preservation-apply.js';
import {
  getStagedAnalyzePaths,
  hasPendingPromotion,
  inspectStagedWorkspaceSource,
  prepareStagedWorkspace,
  promoteStagedGeneration,
  withAnalyzeOwnershipLock,
} from '../core/staged-promotion.js';
import { getCurrentBranch, getCurrentCommit, hasGitDir } from '../storage/git.js';
import { canonicalizePath, registerRepo, saveMeta } from '../storage/repo-manager.js';
import { computePreservationPlan } from './preservation-preview-cli.js';
import type { PreservationPreviewCliOptions } from './preservation-preview-cli.js';

const fail = (message: string): void => {
  process.stderr.write(`  Preservation apply refused: ${message}\n`);
  process.exitCode = 1;
};

const parseApplyOptions = (options: PreservationPreviewCliOptions) => {
  if (
    !options.preserveVerifiedEmbeddings ||
    !options.staged ||
    options.embeddings === undefined ||
    options.embeddings === false
  ) {
    throw new Error('apply requires --preserve-verified-embeddings --staged --embeddings');
  }
  if (options.embeddings !== true) {
    throw new Error(
      'apply does not accept a valued --embeddings argument; use --max-reembed-nodes',
    );
  }
  if (options.incrementalOnly) {
    throw new Error('apply cannot be combined with --incremental-only');
  }
  if (options.dryRun) throw new Error('apply cannot be combined with --dry-run');
  if (typeof options.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.planDigest)) {
    throw new Error('apply requires an exact lowercase 64-hex --plan-digest');
  }
  if (
    typeof options.maxReembedNodes !== 'string' ||
    !/^[1-9][0-9]*$/.test(options.maxReembedNodes) ||
    !Number.isSafeInteger(Number(options.maxReembedNodes))
  ) {
    throw new Error('apply requires a positive safe --max-reembed-nodes');
  }
  if (options.embeddingAuthToken !== undefined) {
    throw new Error('--embedding-auth-token is not accepted before apply admission');
  }
  if (
    options.json ||
    options.force ||
    options.dropEmbeddings ||
    options.repairFts ||
    options.repairVector
  ) {
    throw new Error('apply cannot be combined with preview, force, drop, or repair flags');
  }
  return { planDigest: options.planDigest, maxReembedNodes: Number(options.maxReembedNodes) };
};

export const preservationApplyCommand = async (
  inputPath?: string,
  rawOptions?: Record<string, unknown>,
): Promise<void> => {
  const options = (rawOptions ?? {}) as PreservationPreviewCliOptions;
  const priorOrtLogLevel = process.env.ORT_LOG_LEVEL;
  try {
    const admission = parseApplyOptions(options);
    const initial = await computePreservationPlan(inputPath, options);
    await withAnalyzeOwnershipLock(
      initial.storage.storagePath,
      async () => {
        const context = await computePreservationPlan(inputPath, options);
        if (
          context.repoPath !== initial.repoPath ||
          context.storage.lbugPath !== initial.storage.lbugPath
        ) {
          throw new Error('repository or storage identity changed before locked planning');
        }
        const paths = getStagedAnalyzePaths(
          context.storage.lbugPath,
          path.dirname(context.storage.metaPath),
        );
        const sourceRepo = { head: context.currentCommit, branch: context.currentBranch };
        if (await hasPendingPromotion(paths)) {
          throw new Error('a staged-promotion recovery journal is pending');
        }
        const priorStage = await inspectStagedWorkspaceSource(paths, context.meta, sourceRepo);
        if (priorStage.exists) {
          throw new Error('a pre-existing staged workspace must be resolved before repair apply');
        }

        let semanticMode: 'vector-index' | 'exact-scan' = 'exact-scan';
        let terminalIntegrity: Awaited<ReturnType<typeof inspectEmbeddingIntegrity>> | undefined;
        let observedTotalNodes = context.plan.reembedOwners.length;
        let terminalProgress = {
          nodesProcessed: 0,
          totalNodes: observedTotalNodes,
          chunksProcessed: 0,
        };
        const result = await executePreservationApply({
          plan: context.plan,
          acceptedRows: context.acceptedRows,
          expectedDigest: admission.planDigest,
          maxReembedNodes: admission.maxReembedNodes,
          costAdmission: context.costAdmission,
          runtime: {
            prepareStage: async () => {
              const prepared = await prepareStagedWorkspace(paths, context.meta, sourceRepo);
              if (prepared.resumed) throw new Error('repair apply requires a fresh staged copy');
              return paths;
            },
            mutateStage: async (stage, restoreRows, plan) =>
              withLbugDb(stage.stagedLbugPath, async () => {
                const { batchInsertEmbeddings, runEmbeddingPipeline } =
                  await import('../core/embeddings/embedding-pipeline.js');
                await recreateCodeEmbeddingTable();
                await batchInsertEmbeddings(
                  executeWithReusedStatement,
                  restoreRows.map((row) => ({ ...row, embedding: [...row.embedding] })),
                );
                const restoredRows: typeof context.acceptedRows = [];
                const restoredScan = await scanEmbeddingPreservationRows({
                  onBatch: (batch) => {
                    restoredRows.push(...batch);
                  },
                });
                const existingHashes = new Map(
                  restoreRows.map((row) => [row.nodeId, row.contentHash]),
                );
                const existingRowIds = new Map<string, string[]>();
                for (const row of restoreRows) {
                  existingRowIds.set(row.nodeId, [
                    ...(existingRowIds.get(row.nodeId) ?? []),
                    row.id,
                  ]);
                }
                const regeneratedOwners: string[] = [];
                const pipeline = await runEmbeddingPipeline(
                  executeQuery,
                  executeWithReusedStatement,
                  () => {},
                  { modelId: plan.embedding.model, dimensions: plan.embedding.dimensions },
                  undefined,
                  existingHashes,
                  {
                    forceReembedNodeIds: new Set(plan.reembedOwners),
                    existingEmbeddingRowIds: existingRowIds,
                    onCheckpointWindowStart: async ({ nodeIds, totalNodes }) => {
                      observedTotalNodes = totalNodes;
                      regeneratedOwners.push(...nodeIds);
                    },
                  },
                );
                semanticMode = pipeline.semanticMode;
                terminalProgress = {
                  nodesProcessed: pipeline.nodesProcessed,
                  totalNodes: observedTotalNodes,
                  chunksProcessed: pipeline.chunksProcessed,
                };
                const terminalRows: typeof context.acceptedRows = [];
                const terminalScan = await scanEmbeddingPreservationRows({
                  onBatch: (batch) => {
                    terminalRows.push(...batch);
                  },
                });
                terminalIntegrity = await inspectEmbeddingIntegrity(undefined, true);
                assertEmbeddingIntegrity(terminalIntegrity, 'Preservation terminal embedding');
                return {
                  restoredRows,
                  restoredScan,
                  terminalRows,
                  terminalScan,
                  regeneratedOwners,
                };
              }),
            saveStageMetadata: async (stage, plan) => {
              if (
                !terminalIntegrity ||
                terminalProgress.nodesProcessed !== terminalProgress.totalNodes
              ) {
                throw new Error(
                  'preservation apply did not produce a completed embedding checkpoint',
                );
              }
              await saveMeta(stage.stagedMetaDir, {
                ...context.meta,
                stats: { ...context.meta.stats, embeddings: plan.counts.expectedChunkCount },
                incrementalInProgress: undefined,
                embeddingCheckpoint: {
                  at: new Date().toISOString(),
                  ...terminalProgress,
                  provider: plan.embedding.provider,
                  model: plan.embedding.model,
                  dimensions: plan.embedding.dimensions,
                  pendingNodeIds: [],
                  physicalRows: terminalIntegrity.physicalRows,
                  validRows: terminalIntegrity.validRows,
                  recoverableIdentitySha256: terminalIntegrity.recoverableIdentitySha256,
                  physicalRowsSha256: terminalIntegrity.physicalRowsSha256,
                },
                capabilities: context.meta.capabilities
                  ? {
                      ...context.meta.capabilities,
                      vectorSearch: {
                        ...context.meta.capabilities.vectorSearch,
                        provider:
                          semanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
                        status: plan.counts.expectedChunkCount === 0 ? 'unavailable' : semanticMode,
                      },
                    }
                  : undefined,
              });
            },
            promoteStage: (stage) =>
              promoteStagedGeneration(
                stage,
                async (meta) => {
                  await saveMeta(path.dirname(context.storage.metaPath), meta);
                  return registerRepo(context.repoPath, meta, {
                    branch: context.placement.branch,
                    expectedCanonicalPath: canonicalizePath(context.repoPath),
                    expectedCanonicalStoragePath: canonicalizePath(context.storage.storagePath),
                  });
                },
                {
                  readRepositoryIdentity: () => {
                    const repoHasGit = options.skipGit !== true && hasGitDir(context.repoPath);
                    return {
                      head: repoHasGit ? getCurrentCommit(context.repoPath) : '',
                      branch: repoHasGit ? getCurrentBranch(context.repoPath) : null,
                    };
                  },
                },
              ),
          },
        });
        process.stdout.write(
          `Preservation repair promoted ${context.plan.planDigest} (${result.projectName ?? 'repository'}).\n`,
        );
      },
      { repoRoot: initial.repoPath },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (priorOrtLogLevel === undefined) delete process.env.ORT_LOG_LEVEL;
    else process.env.ORT_LOG_LEVEL = priorOrtLogLevel;
  }
};
