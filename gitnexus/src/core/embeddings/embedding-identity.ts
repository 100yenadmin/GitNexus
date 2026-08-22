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
 * Credentials, query parameters, and fragments are deliberately discarded.
 */
const normalizeEndpointIdentity = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.toString();
  } catch {
    // Do not hash malformed raw input: even a digest of a secret-bearing
    // invalid URL would preserve secret-derived material in durable metadata.
    return INVALID_ENDPOINT;
  }
};

/** Return a deterministic, secret-free provider label for an HTTP endpoint. */
export const httpEmbeddingProvider = (endpoint: string): string =>
  `http:${createHash('sha256').update(normalizeEndpointIdentity(endpoint)).digest('hex')}`;

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
