import { describe, expect, it } from 'vitest';
import {
  embeddingAcceptedPayloadDigest,
  embeddingCanonicalFloat32Bytes,
  embeddingPhysicalVectorInfo,
} from '../../src/core/embeddings/identity-digest.js';

describe('embedding identity digest encodings', () => {
  it('keeps physical v1 values Float64 while accepted payload bytes stay Float32', () => {
    const vector = [0.1, -0, 1.5];

    expect(embeddingPhysicalVectorInfo(vector)).toMatchObject({
      kind: 'array',
      dimensions: 3,
      finite: 'finite',
      sha256: 'e54adde22be695f25ae4a031d58a2a94f497406431f6274a87bb5e75b2d38e2f',
    });
    expect(embeddingCanonicalFloat32Bytes(vector)).toEqual(
      Buffer.from('3dcccccd800000003fc00000', 'hex'),
    );
    expect(
      embeddingAcceptedPayloadDigest([
        {
          id: 'id-0',
          nodeId: 'node-0',
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          contentHash: 'hash',
          embedding: vector,
        },
      ]),
    ).toBe('802df02e03913d39a4b6a0750129526a573c940c5b72a8840a5278336b5751b5');
  });
});
