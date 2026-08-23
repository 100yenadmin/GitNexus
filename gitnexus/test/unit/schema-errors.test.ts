import { describe, expect, it } from 'vitest';
import { isMissingColumnOrTableError } from '../../src/core/lbug/schema-errors.js';

describe('isMissingColumnOrTableError', () => {
  it.each([
    'Binder exception: Table CodeEmbedding does not exist.',
    'Binder exception: column chunkIndex does not exist',
    'Binder exception: property contentHash does not exist',
    'Binder exception: table CodeEmbedding not found in catalog',
    'Binder exception: column chunkIndex not found',
    'Binder exception: property contentHash not found for e.',
  ])('accepts established missing-schema form: %s', (message) => {
    expect(isMissingColumnOrTableError(message)).toBe(true);
  });

  it.each([
    'connection does not exist',
    'query against table CodeEmbedding failed: connection does not exist',
    'Runtime exception: Table Class does not exist.',
    'Runtime exception: Binder exception: Column chunkIndex does not exist',
    'query does not exist',
    'key does not exist',
    'path does not exist',
    'database does not exist',
    'connection not found',
    'query not found',
    'key not found',
    'path not found',
    'database not found',
    'Symbol not found',
  ])('rejects runtime or lookup form: %s', (message) => {
    expect(isMissingColumnOrTableError(message)).toBe(false);
  });
});
