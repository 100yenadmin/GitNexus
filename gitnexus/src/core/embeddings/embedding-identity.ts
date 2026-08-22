import { createHash } from 'node:crypto';

/** Identity of the embedding transport and representation used for a vector. */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
  dimensions: number;
}

const normalizeHttpEndpoint = (endpoint: string): string => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('HTTP embedding endpoint is malformed.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('HTTP embedding endpoint must use HTTP or HTTPS.');
  }
  if (url.search || endpoint.includes('?')) {
    throw new Error('HTTP embedding endpoint query routing is unverifiable.');
  }

  // URL serialization canonicalizes scheme/host/port. Remove all credential,
  // fragment, and query material before deriving the durable provider label.
  url.username = '';
  url.password = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString();
};

/** Return a deterministic provider label without persisting endpoint secrets. */
export const httpEmbeddingProvider = (endpoint: string): string =>
  `http:${createHash('sha256').update(normalizeHttpEndpoint(endpoint)).digest('hex')}`;
