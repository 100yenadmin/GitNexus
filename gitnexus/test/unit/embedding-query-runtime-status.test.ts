import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prefixLoadable, runtimeSource, transformersImport, transformersLoadable } = vi.hoisted(
  () => ({
    prefixLoadable: { value: true },
    runtimeSource: { value: 'package' as 'package' | 'runtime-prefix' },
    transformersImport: vi.fn(),
    transformersLoadable: { value: true },
  }),
);

vi.mock('../../src/core/embeddings/runtime-install.js', () => ({
  ensureEmbeddingStackResolvable: vi.fn(),
  isPrefixRuntimeLoadable: vi.fn(() => prefixLoadable.value),
  resolveEmbeddingRuntime: vi.fn(() => ({ source: runtimeSource.value })),
}));

vi.mock('@huggingface/transformers', () => {
  transformersImport();
  if (!transformersLoadable.value) throw new Error('native runtime unavailable');
  return { env: {}, pipeline: vi.fn() };
});

const loadStatus = async () =>
  (await import('../../src/core/embeddings/runtime-support.js')).getQueryEmbeddingRuntimeStatus();
const expectStatus = (expected: object) => expect(loadStatus()).resolves.toEqual(expected);

describe('provider-free query embedding runtime status', () => {
  beforeEach(() => {
    vi.resetModules();
    prefixLoadable.value = true;
    runtimeSource.value = 'package';
    transformersImport.mockClear();
    transformersLoadable.value = true;
    for (const key of [
      'GITNEXUS_EMBEDDING_URL',
      'GITNEXUS_EMBEDDING_MODEL',
      'GITNEXUS_EMBEDDING_DIMS',
      'GITNEXUS_EMBEDDING_THREADS',
      'GITNEXUS_EMBEDDING_DEVICE',
    ]) delete process.env[key];
  });

  it('rejects a resolvable but unloadable package runtime', async () => {
    transformersLoadable.value = false;

    await expectStatus({
      available: false,
      mode: 'local',
      reason: 'local-runtime-unloadable',
    });
    expect(transformersImport).toHaveBeenCalledTimes(1);
  });

  it('accepts a loadable package runtime without initializing a model', async () => {
    await expectStatus({
      available: true,
      mode: 'local',
      reason: null,
    });
    expect(transformersImport).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP mode available without importing the local runtime', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'https://embedding.example/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    transformersLoadable.value = false;

    await expectStatus({
      available: true,
      mode: 'http',
      reason: null,
    });
    expect(transformersImport).not.toHaveBeenCalled();
  });

  it('preserves the runtime-prefix capability gate', async () => {
    runtimeSource.value = 'runtime-prefix';
    prefixLoadable.value = false;

    await expectStatus({
      available: false,
      mode: 'local',
      reason: 'local-runtime-unloadable',
    });
    expect(transformersImport).not.toHaveBeenCalled();
  });
});
