/**
 * Pure derivation of the embedding-mode flags for `runFullAnalysis`.
 *
 * Lives in its own module (no native imports) so the branching contract can
 * be unit-tested without spinning up LadybugDB, tree-sitter, or any of the
 * other side-effecting dependencies pulled in by `run-analyze.ts`.
 *
 * Semantics:
 *   --drop-embeddings         -> wipe (skip cache load entirely)
 *   --embeddings              -> load cache, restore, then generate
 *   --force + existing>0      -> load cache, restore, then generate (regenerate top-up)
 *   (default) + existing>0    -> preserve only (load + restore, no generation)
 *   any path with existing=0  -> no cache work, no preservation
 */

export interface EmbeddingModeInput {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
}

export interface EmbeddingMode {
  /** True when phase 4 should run the embedding generation pipeline. */
  shouldGenerateEmbeddings: boolean;
  /** True when we should load the cache to re-insert vectors after rebuild without generating new ones. */
  preserveExistingEmbeddings: boolean;
  /** True when `--force` upgraded a default analyze into a regeneration because the repo was already embedded. */
  forceRegenerateEmbeddings: boolean;
  /** True when we need to load cached embeddings from the existing DB before the rebuild. */
  shouldLoadCache: boolean;
}

/** Default safety cap on graph node count for embedding generation. */
export const DEFAULT_EMBEDDING_NODE_LIMIT = 50_000;

export interface EmbeddingCapDecision {
  /** True when the node-count cap blocks generation for this graph. */
  skipForCap: boolean;
  /** True when the cap is disabled explicitly or by the remote-provider default. */
  capDisabled: boolean;
  /** Effective node limit applied (`0` means disabled). */
  nodeLimit: number;
}

/**
 * Preserve an explicit operator cap while letting an interrupted run resume
 * when no cap was supplied. Provider-specific defaults are resolved later by
 * {@link deriveEmbeddingCap}.
 */
export function resolveEmbeddingNodeLimit(
  embeddingsNodeLimit: number | undefined,
  resumeEmbeddingCheckpoint: boolean,
): number | undefined {
  return embeddingsNodeLimit ?? (resumeEmbeddingCheckpoint ? 0 : undefined);
}

/**
 * Decide whether the node-count safety cap blocks embedding generation.
 *
 * - `embeddingsNodeLimit === undefined` → use {@link DEFAULT_EMBEDDING_NODE_LIMIT}
 *   for local models, but disable the cap for remote HTTP providers
 * - `embeddingsNodeLimit === 0` → cap disabled, generation always proceeds
 * - any positive integer → custom cap (skip if `nodeCount > limit`)
 *
 * Lives in `embedding-mode.ts` (not `run-analyze.ts`) so the branching
 * contract is unit-testable without spinning up LadybugDB or the pipeline.
 */
export function deriveEmbeddingCap(
  nodeCount: number,
  embeddingsNodeLimit: number | undefined,
  remoteHttp = false,
): EmbeddingCapDecision {
  const nodeLimit = embeddingsNodeLimit ?? (remoteHttp ? 0 : DEFAULT_EMBEDDING_NODE_LIMIT);
  const capDisabled = nodeLimit === 0;
  const skipForCap = !capDisabled && nodeCount > nodeLimit;
  return { skipForCap, capDisabled, nodeLimit };
}

/**
 * The implicit local-model cap is allowed to downgrade only the automatic
 * `--force` top-up of an already-embedded repository to preserve-only mode.
 * Explicit embedding requests and explicit positive caps remain all-or-
 * nothing admission gates.
 */
export function preserveOnlyForImplicitForceCap(
  skipForCap: boolean,
  forceRegenerateEmbeddings: boolean,
  embeddingsNodeLimit: number | undefined,
): boolean {
  return skipForCap && forceRegenerateEmbeddings && embeddingsNodeLimit === undefined;
}

export function deriveEmbeddingMode(
  options: EmbeddingModeInput,
  existingEmbeddingCount: number,
): EmbeddingMode {
  const hasExisting = existingEmbeddingCount > 0;
  const drop = !!options.dropEmbeddings;
  const explicit = !!options.embeddings;
  const force = !!options.force;

  const forceRegenerateEmbeddings = force && !explicit && !drop && hasExisting;
  const preserveExistingEmbeddings =
    !explicit && !drop && !forceRegenerateEmbeddings && hasExisting;
  const shouldGenerateEmbeddings = explicit || forceRegenerateEmbeddings;
  const shouldLoadCache = !drop && (shouldGenerateEmbeddings || preserveExistingEmbeddings);

  return {
    shouldGenerateEmbeddings,
    preserveExistingEmbeddings,
    forceRegenerateEmbeddings,
    shouldLoadCache,
  };
}
