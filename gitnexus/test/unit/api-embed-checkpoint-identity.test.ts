import { describe, expect, it } from 'vitest';
import {
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

  it('fingerprints equivalent safe endpoint identities without secrets', () => {
    const withSecrets = httpEmbeddingProvider(
      'https://user:secret@example.com/v1/?token=query#fragment',
    );
    expect(withSecrets).toBe(httpEmbeddingProvider('https://example.com/v1'));
    expect(withSecrets).not.toMatch(/secret|query|fragment/u);
    expect(withSecrets).not.toBe(httpEmbeddingProvider('https://example.com/v2'));
  });
});
