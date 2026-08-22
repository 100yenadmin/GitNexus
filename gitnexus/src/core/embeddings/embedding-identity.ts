import { createHash } from 'node:crypto';

/** Durable identity for the transport that produced an embedding vector. */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
  dimensions: number;
}

const INVALID_ENDPOINT = '<invalid-endpoint>';

/**
 * Normalize only the non-sensitive endpoint identity before hashing it.
 * Credentials and fragments are discarded; query-routed endpoints are
 * unverifiable and fail closed.
 */
const normalizeEndpointIdentity = (endpoint: string): string => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // Do not hash malformed raw input: even a digest of a secret-bearing
    // invalid URL would preserve secret-derived material in durable metadata.
    return INVALID_ENDPOINT;
  }
  if (url.search) {
    throw new Error('HTTP embedding endpoint query routing is unverifiable.');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString();
};

/** Return a deterministic, secret-free provider label for an HTTP endpoint. */
export const httpEmbeddingProvider = (endpoint: string): string =>
  `http:${createHash('sha256').update(normalizeEndpointIdentity(endpoint)).digest('hex')}`;

export const assertIncrementalEmbeddingIdentity = (
  survivingRows: number,
  retained: EmbeddingIdentity | undefined,
  active: EmbeddingIdentity,
): void => {
  if (survivingRows <= 0) return;
  if (!retained) {
    throw new Error('Cannot incrementally generate: surviving vectors lack durable identity.');
  }
  if (
    retained.provider !== active.provider ||
    retained.model !== active.model ||
    retained.dimensions !== active.dimensions
  ) {
    throw new Error(
      `Embedding identity mismatch: retained ${retained.provider}/${retained.model}/${retained.dimensions}; ` +
        `active ${active.provider}/${active.model}/${active.dimensions}.`,
    );
  }
};

/**
 * Select the durable identity for the vectors visible at finalization.
 * A retention-only run must carry forward known identity, while legacy
 * metadata and an empty table remain explicitly unknown.
 */
export const resolveDurableEmbeddingIdentity = (
  embeddingCount: number,
  generated: EmbeddingIdentity | undefined,
  existing: EmbeddingIdentity | undefined,
): EmbeddingIdentity | undefined => (embeddingCount > 0 ? (generated ?? existing) : undefined);
