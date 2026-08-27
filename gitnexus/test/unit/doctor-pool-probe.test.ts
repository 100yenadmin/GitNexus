import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolMocks = vi.hoisted(() => ({
  closeLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue([]),
  getPoolCapabilities: vi.fn(),
  initLbugNonRecovering: vi.fn().mockResolvedValue(undefined),
  probePoolConnections: vi.fn().mockResolvedValue(8),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => poolMocks);

const { probeDoctorPool } = await import('../../src/cli/doctor-pool-probe.js');

describe('shared doctor read-pool probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMocks.initLbugNonRecovering.mockResolvedValue(undefined);
    poolMocks.probePoolConnections.mockResolvedValue(8);
    poolMocks.executeQuery.mockImplementation(async (_repoId: string, cypher: string) =>
      cypher.includes('TABLE_INFO') ? [{ name: 'embedding', type: 'FLOAT[384]' }] : [],
    );
    poolMocks.getPoolCapabilities.mockReturnValue({
      fts: true,
      vector: true,
      connectionCount: 8,
    });
  });

  it('uses non-recovering initialization and exercises all eight connections', async () => {
    const result = await probeDoctorPool('/repo/.gitnexus/lbug');

    expect(poolMocks.initLbugNonRecovering).toHaveBeenCalledWith(
      expect.stringMatching(/^doctor:/),
      '/repo/.gitnexus/lbug',
    );
    expect(poolMocks.probePoolConnections).toHaveBeenCalledOnce();
    expect(result).toEqual({
      fts: true,
      vector: true,
      vectorIndex: true,
      vectorIndexReason: null,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    });
    expect(poolMocks.executeQuery).toHaveBeenCalledWith(
      expect.stringMatching(/^doctor:/),
      expect.stringMatching(/QUERY_VECTOR_INDEX.*code_embedding_idx/s),
    );
    expect(poolMocks.closeLbug).toHaveBeenCalledOnce();
  });

  it('preserves aggregate optional-extension failures from the complete pool', async () => {
    poolMocks.getPoolCapabilities.mockReturnValue({
      fts: true,
      vector: false,
      connectionCount: 8,
    });

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: true,
      vector: false,
      vectorIndex: false,
      vectorIndexReason: 'vector-extension-unavailable',
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    });
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('reports a missing named HNSW index without hiding healthy graph and FTS capability', async () => {
    poolMocks.executeQuery.mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('TABLE_INFO')) return [{ name: 'embedding', type: 'FLOAT[384]' }];
      throw new Error("Table CodeEmbedding doesn't have an index with name code_embedding_idx");
    });

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toEqual({
      fts: true,
      vector: true,
      vectorIndex: false,
      vectorIndexReason: 'vector-index-missing-or-unqueryable',
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    });
  });

  it('probes the vector index at the dimension stored in the database', async () => {
    poolMocks.executeQuery.mockImplementation(async (_repoId: string, cypher: string) =>
      cypher.includes('TABLE_INFO') ? [{ name: 'embedding', type: 'FLOAT[2048]' }] : [],
    );

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      vectorIndex: true,
      vectorIndexReason: null,
    });

    const vectorCall = poolMocks.executeQuery.mock.calls.find(([, cypher]) =>
      String(cypher).includes('QUERY_VECTOR_INDEX'),
    );
    expect(vectorCall?.[1]).toContain('FLOAT[2048]');
  });

  it.each([
    [{ name: 'embedding', type: 'FLOAT[0]' }],
    [{ name: 'embedding', type: 'FLOAT[65537]' }],
    [{ name: 'embedding', type: 'FLOAT[not-a-number]' }],
    [{ name: 'other', type: 'FLOAT[2048]' }],
  ])('fails closed when the stored embedding dimension is unavailable or invalid', async (rows) => {
    poolMocks.executeQuery.mockImplementation(async (_repoId: string, cypher: string) =>
      cypher.includes('TABLE_INFO') ? rows : [],
    );

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: true,
      vector: true,
      vectorIndex: false,
      vectorIndexReason: 'vector-index-missing-or-unqueryable',
      reason: null,
    });
    expect(
      poolMocks.executeQuery.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(false);
  });

  it('fails closed and closes the pool when fewer than eight connections are exercised', async () => {
    poolMocks.probePoolConnections.mockResolvedValue(7);

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: false,
      vector: false,
      exercisedConnections: 0,
      connectionCount: 0,
      reason: expect.stringMatching(/all eight connections/i),
    });
    expect(poolMocks.closeLbug).toHaveBeenCalledOnce();
  });

  it('does not initialize when cleanup support is unavailable', async () => {
    const closeLbug = poolMocks.closeLbug;
    Reflect.set(poolMocks, 'closeLbug', undefined);
    try {
      await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
        fts: false,
        vector: false,
        exercisedConnections: 0,
        connectionCount: 0,
        reason: 'non-recovering read-pool capability probe is unavailable',
      });
      expect(poolMocks.initLbugNonRecovering).not.toHaveBeenCalled();
    } finally {
      Reflect.set(poolMocks, 'closeLbug', closeLbug);
    }
  });

  it('closes the diagnostic pool when non-recovering initialization fails', async () => {
    poolMocks.initLbugNonRecovering.mockRejectedValue(new Error('WAL requires recovery'));

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: false,
      vector: false,
      exercisedConnections: 0,
      connectionCount: 0,
      reason: 'WAL requires recovery',
    });
    expect(poolMocks.probePoolConnections).not.toHaveBeenCalled();
    expect(poolMocks.closeLbug).toHaveBeenCalledOnce();
  });
});
