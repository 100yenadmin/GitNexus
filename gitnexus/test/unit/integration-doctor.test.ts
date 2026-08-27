import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

describe('doctor --integrations', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-integration-doctor-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await Promise.all([
      fs.mkdir(path.join(home, '.claude'), { recursive: true }),
      fs.mkdir(path.join(home, '.codex'), { recursive: true }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeMatchingMcp() {
    const entry = { command: '/opt/gitnexus-wrapper', args: ['mcp'], env: { SECRET: 'hidden' } };
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { gitnexus: entry },
        projects: { '/repo': { mcpServers: { gitnexus: entry } } },
      }),
    );
    await fs.writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.gitnexus]\ncommand = "/opt/gitnexus-wrapper"\nargs = ["mcp"]\n\n[mcp_servers.gitnexus.env]\nSECRET = "hidden"\n',
    );
  }

  it('reports matching MCP entries and a freshly installed Claude hook bundle as current', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    const report = await buildIntegrationDoctorReport(home);

    expect(report.mcp).toEqual({
      status: 'consistent',
      codexConfigured: true,
      claudeConfiguredEntries: 2,
    });
    expect(report.hooks).toEqual({ claude: 'current', obsoleteSessionStart: false });
    expect(JSON.stringify(report)).not.toContain('/opt/gitnexus-wrapper');
    expect(JSON.stringify(report)).not.toContain('hidden');
  });

  it('distinguishes a stale hook from a missing hook', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const adapter = path.join(home, '.claude', 'hooks', 'gitnexus', 'gitnexus-hook.cjs');
    await fs.appendFile(adapter, '\n// stale\n');
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'stale' },
    });
    await fs.rm(adapter);
    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'missing' },
    });
  });

  it('reports stale when settings still invoke an old hook path', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    settings.hooks.PreToolUse[0].hooks[0].command = 'node /old/gitnexus-hook.cjs';
    await fs.writeFile(settingsPath, JSON.stringify(settings));
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');

    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'stale' },
    });
  });

  it('detects the legacy session-context hook while current tool hooks are installed', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    settings.hooks.SessionStart = [
      { hooks: [{ type: 'command', command: 'gitnexus session-context' }] },
    ];
    await fs.writeFile(settingsPath, JSON.stringify(settings));
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');

    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'current', obsoleteSessionStart: true },
    });
  });

  it('ignores a missing best-effort hook helper when judging freshness', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    await fs.rm(path.join(home, '.claude', 'hooks', 'gitnexus', 'win-rm-list-json.ps1'), {
      force: true,
    });
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');

    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'current' },
    });
  });

  it('treats an unrelated Codex config as a missing MCP integration', async () => {
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');

    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      mcp: { status: 'missing', codexConfigured: false },
    });
  });

  it('treats an empty Claude config as a missing MCP integration', async () => {
    await fs.writeFile(path.join(home, '.claude.json'), '  \n');
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');

    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      mcp: { status: 'missing', claudeConfiguredEntries: 0 },
    });
  });

  it('reports a sanitized MCP mismatch without returning config values', async () => {
    await writeMatchingMcp();
    const claudePath = path.join(home, '.claude.json');
    const config = JSON.parse(await fs.readFile(claudePath, 'utf8'));
    config.projects['/repo'].mcpServers.gitnexus.command = '/other-runtime';
    await fs.writeFile(claudePath, JSON.stringify(config));
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    const report = await buildIntegrationDoctorReport(home);
    expect(report.mcp.status).toBe('mismatch');
    expect(JSON.stringify(report)).not.toContain('/other-runtime');
  });

  it('detects environment-only MCP mismatches without exposing their values', async () => {
    await writeMatchingMcp();
    const claudePath = path.join(home, '.claude.json');
    const config = JSON.parse(await fs.readFile(claudePath, 'utf8'));
    config.projects['/repo'].mcpServers.gitnexus.env.SECRET = 'different-secret';
    await fs.writeFile(claudePath, JSON.stringify(config));
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    const report = await buildIntegrationDoctorReport(home);
    expect(report.mcp.status).toBe('mismatch');
    expect(JSON.stringify(report)).not.toContain('different-secret');
    expect(JSON.stringify(report)).not.toContain('hidden');
  });
});
