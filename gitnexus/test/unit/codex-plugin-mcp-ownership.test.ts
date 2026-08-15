import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'gitnexus-claude-plugin');

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('Codex plugin MCP ownership', () => {
  it('loads skills and hooks without declaring a second GitNexus MCP server', async () => {
    const manifest = await readJson('.codex-plugin/plugin.json');

    expect(manifest.skills).toBe('./skills');
    expect(manifest.hooks).toBe('./hooks/hooks.json');
    expect(manifest).not.toHaveProperty('mcpServers');
  });

  it('preserves the standalone Claude plugin MCP configuration', async () => {
    const mcpConfig = await readJson('.mcp.json');

    expect(mcpConfig).toEqual({
      mcpServers: {
        gitnexus: {
          command: 'npx',
          args: ['-y', 'gitnexus@latest', 'mcp'],
        },
      },
    });
  });
});
