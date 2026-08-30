import { afterEach, describe, expect, it, vi } from 'vitest';
import { preservationPreviewCommand } from '../../src/cli/preservation-preview-cli.js';

describe('preservation preview CLI admission', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses an incomplete preview before repository or provider work', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await preservationPreviewCommand(undefined, {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('requires'));
    expect(stdout).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an auth token before reading repository state', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await preservationPreviewCommand('/definitely/not/a/repository', {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
      json: true,
      staged: true,
      embeddings: true,
      embeddingAuthToken: 'synthetic-test-value',
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not accepted'));
    expect(stdout).not.toHaveBeenCalled();
  });

  it('dispatches preservation apply without loading the ordinary analyzer', async () => {
    const apply = vi.fn(async () => undefined);
    const analyze = vi.fn(async () => undefined);
    vi.doMock('../../src/cli/preservation-apply-cli.js', () => ({
      preservationApplyCommand: apply,
    }));
    vi.doMock('../../src/cli/analyze.js', () => ({ analyzeCommand: analyze }));
    vi.resetModules();
    const { analyzeAction } = await import('../../src/cli/analyze-action.js');

    const options = {
      preserveVerifiedEmbeddings: true,
      staged: true,
      embeddings: true,
      planDigest: 'a'.repeat(64),
      maxReembedNodes: '1',
    };
    await analyzeAction('/repo', options);

    expect(apply).toHaveBeenCalledWith('/repo', options);
    expect(analyze).not.toHaveBeenCalled();
    vi.doUnmock('../../src/cli/preservation-apply-cli.js');
    vi.doUnmock('../../src/cli/analyze.js');
    vi.resetModules();
  });
});
