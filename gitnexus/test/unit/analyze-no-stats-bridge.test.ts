import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runFullAnalysisMock,
  generateAIContextFilesMock,
  generateSkillFilesMock,
  cliErrorMock,
  installEmbeddingRuntimeMock,
} = vi.hoisted(() => {
  const runFullAnalysisMock = vi.fn();
  const generateAIContextFilesMock = vi.fn(async () => ({ files: [] as string[] }));
  const generateSkillFilesMock = vi.fn(async () => ({
    skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
    outputPath: '/repo/.claude/skills/generated',
  }));
  const cliErrorMock = vi.fn();
  const installEmbeddingRuntimeMock = vi.fn();
  return {
    runFullAnalysisMock,
    generateAIContextFilesMock,
    generateSkillFilesMock,
    cliErrorMock,
    installEmbeddingRuntimeMock,
  };
});

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
}));

vi.mock('../../src/cli/skill-gen.js', () => ({
  generateSkillFiles: generateSkillFilesMock,
}));

vi.mock('../../src/cli/cli-message.js', () => ({
  cliError: cliErrorMock,
}));

vi.mock('../../src/core/embeddings/runtime-install.js', () => ({
  ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS: 30_000,
  getEmbeddingInstallTimeoutMs: vi.fn(() => 30_000),
  getEmbeddingRuntimeDir: vi.fn(() => '/tmp/gitnexus-embedding-runtime'),
  installEmbeddingRuntime: installEmbeddingRuntimeMock,
  isPrefixRuntimeLoadable: vi.fn(() => true),
  resolveEmbeddingRuntime: vi.fn(() => null),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  // #243: default-branch auto-detection. Return null so the resolver falls back
  // to "main" deterministically in this mocked environment.
  getDefaultBranch: vi.fn(() => null),
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

describe('analyzeCommand commander → runFullAnalysis noStats bridge (#1477)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });
    generateAIContextFilesMock.mockReset();
    generateAIContextFilesMock.mockResolvedValue({ files: [] });
    generateSkillFilesMock.mockReset();
    generateSkillFilesMock.mockResolvedValue({
      skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
      outputPath: '/repo/.claude/skills/generated',
    });
    cliErrorMock.mockReset();
    installEmbeddingRuntimeMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('maps commander-shaped stats:false to noStats:true (equivalent to --no-stats)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false });

    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(true);
  });

  it('maps omitted stats to noStats:false (default-on preserved)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(false);
  });

  it('maps explicit stats:true to noStats:false', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(false);
  });

  it('still maps stats:false to noStats:true when skipAgentsMd is set', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false, skipAgentsMd: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(true);
    expect(opts.skipAgentsMd).toBe(true);
  });

  it('passes --repair-fts through to runFullAnalysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairFts: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.repairFts).toBe(true);
  });

  it('passes --repair-vector through to runFullAnalysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairVector: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.repairVector).toBe(true);
  });

  it('allows --repair-vector when repository config disables embeddings', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairVector: true, embeddings: false });

    expect(process.exitCode).not.toBe(1);
    expect(runFullAnalysisMock).toHaveBeenCalledOnce();
    expect(runFullAnalysisMock.mock.calls[0][1]).toMatchObject({
      repairVector: true,
      embeddings: false,
    });
  });

  it.each([
    ['--force', { force: true }],
    ['--staged', { staged: true }],
    ['--incremental-only', { incrementalOnly: true }],
    ['--repair-fts', { repairFts: true }],
    ['--embeddings', { embeddings: true }],
    ['--embeddings 100', { embeddings: '100' }],
    ['--drop-embeddings', { dropEmbeddings: true }],
    ['--skills', { skills: true }],
    ['--pdg', { pdg: true }],
    ['--branch', { branch: 'main' }],
  ])('rejects combining --repair-vector with %s', async (_label, conflicting) => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairVector: true, ...conflicting });

    expect(process.exitCode).toBe(1);
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cannot combine `--repair-vector`/i),
    );
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
  });

  it('passes --incremental-only through to runFullAnalysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { incrementalOnly: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.incrementalOnly).toBe(true);
  });

  it('rejects combining --incremental-only with --drop-embeddings', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { incrementalOnly: true, dropEmbeddings: true });

    expect(process.exitCode).toBe(1);
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cannot combine `--incremental-only`.*`--drop-embeddings`/i),
    );
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
  });

  it('passes --staged through to runFullAnalysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { staged: true });

    expect(runFullAnalysisMock.mock.calls[0][1].staged).toBe(true);
  });

  it('rejects combining --repair-fts with --force', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairFts: true, force: true });

    expect(process.exitCode).toBe(1);
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cannot combine `--repair-fts` with `--force`/i),
    );
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
  });

  it.each([
    ['--force', { force: true }],
    ['--repair-fts', { repairFts: true }],
    ['--skills', { skills: true }],
  ])('rejects combining --incremental-only with %s', async (_label, conflicting) => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { incrementalOnly: true, ...conflicting });

    expect(process.exitCode).toBe(1);
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cannot combine `--incremental-only`/i),
    );
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
  });

  it('passes stats:false as noStats to generateAIContextFiles on the --skills regeneration path (#1477)', async () => {
    runFullAnalysisMock.mockResolvedValueOnce({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {
        files: 1,
        nodes: 10,
        edges: 20,
        communities: 0,
        processes: 5,
      },
      alreadyUpToDate: false,
      pipelineResult: { communityResult: undefined },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { skills: true, stats: false });

      expect(generateSkillFilesMock).toHaveBeenCalledTimes(1);
      expect(generateAIContextFilesMock).toHaveBeenCalledTimes(1);
      const aiCtxOpts = generateAIContextFilesMock.mock.calls[0]![5];
      expect(aiCtxOpts).toEqual({
        skipAgentsMd: undefined,
        skipSkills: undefined,
        // #243: resolved default branch threaded into the --skills regen path.
        defaultBranch: 'main',
        noStats: true,
        // #2086 M6: the --pdg gate is threaded too; false here (no --pdg flag).
        hasPdg: false,
      });
    } finally {
      exitSpy.mockRestore();
    }
  });
});
