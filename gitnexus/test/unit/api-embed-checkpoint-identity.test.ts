import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('API embedding checkpoint identity foundation', () => {
  it('stamps the active identity and refuses an unknown legacy provider', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf8',
    );

    expect(source).toMatch(/isEmptyLegacyCheckpoint\(checkpoint\)/);
    expect(source).toMatch(/checkpoint\.provider === identity\.provider/);
    expect(source).toMatch(/unknown-provider/);
    expect(source).toMatch(/embeddingCheckpoint:\s*\{[\s\S]*\.\.\.embeddingIdentity/);
  });
});
