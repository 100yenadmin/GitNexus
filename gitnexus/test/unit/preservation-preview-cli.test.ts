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
});
