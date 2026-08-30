/**
 * Keep preservation preview dispatch ahead of the ordinary analyzer import.
 * The preview path must not initialize the embedding runtime or mutate the
 * canonical index merely because it shares the `analyze` command surface.
 */
export const analyzeAction = async (inputPath?: string, options?: Record<string, unknown>) => {
  const hasPreservationOnlyOption =
    options?.dryRun === true ||
    options?.json === true ||
    options?.planDigest !== undefined ||
    options?.maxReembedNodes !== undefined;
  if (hasPreservationOnlyOption && options?.preserveVerifiedEmbeddings !== true) {
    throw new Error('preservation-only options require --preserve-verified-embeddings');
  }
  if (options?.preserveVerifiedEmbeddings === true) {
    if (options?.dryRun === true) {
      const { preservationPreviewCommand } = await import('./preservation-preview-cli.js');
      return preservationPreviewCommand(inputPath, options);
    }
    const { preservationApplyCommand } = await import('./preservation-apply-cli.js');
    return preservationApplyCommand(inputPath, options);
  }
  const { analyzeCommand } = await import('./analyze.js');
  return analyzeCommand(inputPath, options);
};
