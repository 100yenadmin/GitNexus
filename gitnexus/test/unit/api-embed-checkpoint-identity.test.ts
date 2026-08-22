import { describe, expect, it } from 'vitest';
import {
  assertIncrementalEmbeddingIdentity,
  httpEmbeddingProvider,
  resolveDurableEmbeddingIdentity,
  type EmbeddingIdentity,
} from '../../src/core/embeddings/embedding-identity.js';

const local: EmbeddingIdentity = {
  provider: 'local',
  model: 'local-model',
  dimensions: 384,
};
const remote: EmbeddingIdentity = {
  provider: 'http:remote',
  model: 'remote-model',
  dimensions: 1024,
};

describe('durable embedding identity', () => {
  it('stamps the identity produced by a nonzero generation', () => {
    expect(resolveDurableEmbeddingIdentity(3, remote, local)).toEqual(remote);
  });

  it('retains known identity without regeneration', () => {
    expect(resolveDurableEmbeddingIdentity(3, undefined, local)).toEqual(local);
  });

  it('clears identity when no vectors remain', () => {
    expect(resolveDurableEmbeddingIdentity(0, remote, local)).toBeUndefined();
  });

  it('leaves legacy identity absence unknown', () => {
    expect(resolveDurableEmbeddingIdentity(3, undefined, undefined)).toBeUndefined();
  });

  it('permits matching retained identity and refuses unknown or mismatched space', () => {
    expect(() => assertIncrementalEmbeddingIdentity(3, local, local)).not.toThrow();
    expect(() => assertIncrementalEmbeddingIdentity(3, undefined, local)).toThrow(
      /durable identity/i,
    );
    expect(() => assertIncrementalEmbeddingIdentity(3, local, remote)).toThrow(
      /identity mismatch/i,
    );
  });

  it('fingerprints equivalent safe endpoint identities without secrets', () => {
    const withSecrets = httpEmbeddingProvider('https://user:secret@example.com/v1/#fragment');
    expect(withSecrets).toBe(httpEmbeddingProvider('https://example.com/v1'));
    expect(withSecrets).not.toMatch(/secret|fragment/u);
    expect(withSecrets).not.toBe(httpEmbeddingProvider('https://example.com/v2'));
  });

  it('rejects query-routed endpoints as unverifiable', () => {
    expect(() => httpEmbeddingProvider('https://example.com/v1?deployment=one')).toThrow(
      /query routing is unverifiable/i,
    );
    expect(() => httpEmbeddingProvider('https://example.com/v1?deployment=two')).toThrow(
      /query routing is unverifiable/i,
    );
  });
});
