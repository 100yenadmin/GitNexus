import { afterEach, describe, expect, it, vi } from 'vitest';

describe('analyze action preservation dispatch', () => {
  afterEach(() => {
    vi.doUnmock('../../src/cli/analyze.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it.each([
    ['--dry-run', { dryRun: true }],
    ['--json', { json: true }],
    ['--plan-digest', { planDigest: 'a'.repeat(64) }],
    ['--max-reembed-nodes', { maxReembedNodes: '1' }],
  ])('refuses %s before ordinary analyze', async (_flag, options) => {
    const analyze = vi.fn(async () => undefined);
    vi.doMock('../../src/cli/analyze.js', () => ({ analyzeCommand: analyze }));
    const { analyzeAction } = await import('../../src/cli/analyze-action.js');

    await expect(analyzeAction('/repo', options)).rejects.toThrow(
      'preservation-only options require --preserve-verified-embeddings',
    );
    expect(analyze).not.toHaveBeenCalled();
  });

  it('keeps ordinary analyze behavior when preservation-only flags are absent', async () => {
    const analyze = vi.fn(async () => 'ordinary');
    vi.doMock('../../src/cli/analyze.js', () => ({ analyzeCommand: analyze }));
    const { analyzeAction } = await import('../../src/cli/analyze-action.js');

    await expect(analyzeAction('/repo', { force: true })).resolves.toBe('ordinary');
    expect(analyze).toHaveBeenCalledWith('/repo', { force: true });
  });
});
