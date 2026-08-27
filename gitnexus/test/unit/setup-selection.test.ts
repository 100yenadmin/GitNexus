import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') callback(null, '', '');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

describe('setupCommand coding-agent selection', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalExitCode: number | string | null | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalExitCode = process.exitCode;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-setup-selection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.exitCode = undefined;
    await Promise.all([
      fs.mkdir(path.join(tempHome, '.cursor'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.claude'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.codex'), { recursive: true }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.exitCode = originalExitCode;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('explicit -c codebuddy succeeds when only a legacy root config exists (no dot-dir)', async () => {
    const legacy = path.join(tempHome, '.codebuddy.json');
    await fs.writeFile(
      legacy,
      JSON.stringify({ mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['codebuddy'] });

    const config = JSON.parse(await fs.readFile(legacy, 'utf-8'));
    expect(config.mcpServers.gitnexus).toBeDefined();
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    // Explicit selection that configures something must not exit 1.
    expect(process.exitCode).not.toBe(1);
  });

  it('configures only the requested coding agent', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['opencode'] });

    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
    await expect(
      fs.access(path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json')),
    ).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('accepts comma-separated and repeated selections without configuring others', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['cursor,opencode', 'cursor'] });

    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
  });

  it('rejects unknown values before writing configuration', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['opencode,unknown'] });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Valid values: cursor, claude, antigravity, opencode, codebuddy, qoder, codex',
      ),
    );
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).rejects.toThrow();
  });

  it.each([
    ['an empty string', ''],
    ['an empty array', []],
  ])('rejects %s before writing configuration', async (_label, codingAgent) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('No coding agents were provided.'));
    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).rejects.toThrow();
  });

  it('fails clearly when an explicitly selected agent is not installed', async () => {
    await fs.rm(path.join(tempHome, '.codex'), { recursive: true, force: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent: ['codex'] });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      'None of the explicitly selected coding agents were configured.\n',
    );
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('MCP is ready!');
  });

  it('preserves the no-flag default of configuring every detected agent', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
  });

  it('hooks-only refreshes Claude hooks without touching MCP, skills, or unrelated hooks', async () => {
    const claudeJsonPath = path.join(tempHome, '.claude.json');
    const skillsPath = path.join(tempHome, '.claude', 'skills', 'keep', 'SKILL.md');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const claudeJson =
      '{"mcpServers":{"gitnexus":{"command":"curated-wrapper","env":{"KEEP":"1"}}}}\n';
    await fs.mkdir(path.dirname(skillsPath), { recursive: true });
    await fs.writeFile(claudeJsonPath, claudeJson);
    await fs.writeFile(skillsPath, 'keep me');
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'node /old/gitnexus-hook.cjs' }] },
              { hooks: [{ type: 'command', command: 'echo keep-session' }] },
            ],
            PreToolUse: [
              {
                hooks: [
                  { type: 'command', command: 'echo keep-pre' },
                  { type: 'command', command: 'node /old/gitnexus-hook.cjs' },
                ],
              },
            ],
            PostToolUse: [{ hooks: [{ type: 'command', command: 'node /old/gitnexus-hook.cjs' }] }],
          },
          permissions: { allow: ['Read'] },
        },
        null,
        2,
      ),
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });

    expect(await fs.readFile(claudeJsonPath, 'utf8')).toBe(claudeJson);
    expect(await fs.readFile(skillsPath, 'utf8')).toBe('keep me');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('keep-session');
    expect(JSON.stringify(settings.hooks.SessionStart)).not.toContain('gitnexus');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('keep-pre');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('gitnexus-hook');
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('gitnexus-hook');
    expect(JSON.stringify(settings.hooks)).not.toContain('/old/gitnexus-hook.cjs');
    for (const file of [
      'gitnexus-hook.cjs',
      'hook-lock.cjs',
      'hook-db-lock-probe.cjs',
      'resolve-analyze-cmd.cjs',
      'win-rm-list-json.ps1',
    ]) {
      await expect(
        fs.access(path.join(tempHome, '.claude', 'hooks', 'gitnexus', file)),
      ).resolves.toBeUndefined();
    }
  });

  it('hooks-only initializes a blank Claude settings file', async () => {
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    await fs.writeFile(settingsPath, '  \n');
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });

    expect(process.exitCode).not.toBe(1);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('gitnexus-hook');
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('gitnexus-hook');
  });

  it('hooks-only fails when Claude is not installed', async () => {
    await fs.rm(path.join(tempHome, '.claude'), { recursive: true, force: true });
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'Claude config directory is missing',
    );
  });

  it('hooks-only requires exactly Claude and performs no writes on invalid selection', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['codex'], hooksOnly: true });
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      '`--hooks-only` requires exactly `--coding-agent claude`.\n',
    );
    await expect(fs.access(path.join(tempHome, '.codex', 'hooks', 'gitnexus'))).rejects.toThrow();
  });
});
