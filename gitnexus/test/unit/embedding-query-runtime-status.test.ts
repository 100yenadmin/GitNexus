import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hookCalls, prefixLoadable, runtimeSource, transformersLoadable } = vi.hoisted(() => ({
  hookCalls: [] as string[],
  prefixLoadable: { value: true },
  runtimeSource: { value: 'package' as 'package' | 'runtime-prefix' },
  transformersLoadable: { value: true },
}));

vi.mock('../../src/core/embeddings/runtime-install.js', () => ({
  ensureEmbeddingStackResolvable: vi.fn(() => hookCalls.push('stack')),
  isPrefixRuntimeLoadable: vi.fn(() => prefixLoadable.value),
  resolveEmbeddingRuntime: vi.fn(() => ({ source: runtimeSource.value })),
}));
vi.mock('../../src/core/embeddings/onnxruntime-common-resolver.js', () => ({
  ensureOnnxRuntimeCommonResolvable: vi.fn(() => hookCalls.push('common')),
}));
vi.mock('../../src/core/embeddings/onnxruntime-node-resolver.js', () => ({
  ensureOnnxRuntimeNodeMatchesSystem: vi.fn(() => hookCalls.push('node')),
}));

vi.mock('@huggingface/transformers', () => {
  hookCalls.push('transformers');
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
    hookCalls.length = 0;
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
    expect(hookCalls).toEqual(['stack', 'common', 'node', 'transformers']);
  });

  it('accepts a loadable package runtime without initializing a model', async () => {
    await expectStatus({
      available: true,
      mode: 'local',
      reason: null,
    });
    expect(hookCalls).toEqual(['stack', 'common', 'node', 'transformers']);
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
    expect(hookCalls).toEqual([]);
  });

  it('preserves the runtime-prefix capability gate', async () => {
    runtimeSource.value = 'runtime-prefix';
    prefixLoadable.value = false;

    await expectStatus({
      available: false,
      mode: 'local',
      reason: 'local-runtime-unloadable',
    });
    expect(hookCalls).toEqual([]);
  });
});
