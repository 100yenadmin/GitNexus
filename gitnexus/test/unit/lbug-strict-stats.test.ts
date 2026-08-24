import { describe, expect, it, vi } from 'vitest';
import { getStrictLbugStats } from '../../src/core/lbug/lbug-adapter.js';
import { NODE_TABLES, REL_TABLE_NAME } from '../../src/core/lbug/schema.js';

describe('getStrictLbugStats', () => {
  it('fails without an active connection', async () => {
    await expect(getStrictLbugStats()).rejects.toThrow('LadybugDB not initialized');
  });

  it('counts every canonical node table and CodeRelation', async () => {
    const queries: string[] = [];
    const runQuery = vi.fn(async (query: string) => {
      queries.push(query);
      return [{ cnt: query.includes(`:${REL_TABLE_NAME}`) ? 2n : 1n }];
    });

    await expect(getStrictLbugStats(runQuery)).resolves.toEqual({
      nodes: NODE_TABLES.length,
      edges: 2,
    });
    expect(queries).toHaveLength(NODE_TABLES.length + 1);
    for (const tableName of NODE_TABLES) {
      expect(queries).toContain(`MATCH (n:\`${tableName}\`) RETURN count(n) AS cnt`);
    }
    expect(queries.at(-1)).toBe(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`);
  });

  it.each([NODE_TABLES[0], REL_TABLE_NAME])(
    'uses zero only for an explicit missing error naming %s',
    async (missing) => {
      const runQuery = vi.fn(async (query: string) => {
        if (query.includes(missing)) {
          throw new Error(`Binder exception: Table ${missing} does not exist.`);
        }
        return [{ cnt: 1 }];
      });

      await expect(getStrictLbugStats(runQuery)).resolves.toEqual({
        nodes: NODE_TABLES.length - Number(missing !== REL_TABLE_NAME),
        edges: Number(missing !== REL_TABLE_NAME),
      });
    },
  );

  it.each([
    'Binder exception: Table WrongTable does not exist.',
    `Binder exception: Column ${NODE_TABLES[0]} does not exist.`,
    `Binder exception: Property ${NODE_TABLES[0]} not found.`,
    'connection does not exist',
    'query failed',
    'transaction aborted',
    'native drain failure',
  ])('propagates unclassified errors: %s', async (message) => {
    await expect(
      getStrictLbugStats(async () => {
        throw new Error(message);
      }),
    ).rejects.toThrow(message);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '4', undefined])(
    'rejects an invalid count: %s',
    async (count) => {
      await expect(getStrictLbugStats(async () => [{ cnt: count }])).rejects.toThrow(
        'Invalid graph count',
      );
    },
  );

  it('rejects an unsafe aggregate node count', async () => {
    await expect(
      getStrictLbugStats(async () => [{ cnt: Number.MAX_SAFE_INTEGER }]),
    ).rejects.toThrow('Invalid total graph node count');
  });
});
