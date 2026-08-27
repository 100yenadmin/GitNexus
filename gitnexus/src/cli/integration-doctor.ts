import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { getEditorTargets, hookTarget, mcpTarget } from './editor-targets.js';
import {
  BEST_EFFORT_CLAUDE_HOOK_HELPERS,
  CLAUDE_HOOK_ADAPTER,
  CLAUDE_HOOK_HELPERS,
  formatHookCommand,
  patchClaudeHookCliPath,
} from './claude-hook-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

type HookStatus = 'current' | 'stale' | 'missing';
type McpStatus = 'consistent' | 'mismatch' | 'missing' | 'invalid';

export interface IntegrationDoctorReport {
  selectedCli: { version: string };
  mcp: {
    status: McpStatus;
    codexConfigured: boolean;
    claudeConfiguredEntries: number;
  };
  hooks: {
    claude: HookStatus;
    obsoleteSessionStart: boolean;
  };
}

const digest = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

const readOptional = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const entryFingerprint = (entry: unknown): string | null => {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof record.command !== 'string') return null;
  const args = Array.isArray(record.args) ? record.args : [];
  if (!args.every((arg) => typeof arg === 'string')) return null;
  const envValue = record.env ?? {};
  if (!envValue || typeof envValue !== 'object' || Array.isArray(envValue)) return null;
  const envEntries = Object.entries(envValue as Record<string, unknown>);
  if (envEntries.some(([, value]) => typeof value !== 'string')) return null;
  const env = Object.fromEntries(
    envEntries.sort(([left], [right]) => left.localeCompare(right)) as Array<[string, string]>,
  );
  return JSON.stringify({ command: record.command, args, env });
};

const collectClaudeMcpEntries = (root: unknown): unknown[] => {
  const found: unknown[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    const record = value as Record<string, unknown>;
    const servers = record.mcpServers;
    if (servers && typeof servers === 'object') {
      const gitnexus = (servers as Record<string, unknown>).gitnexus;
      if (gitnexus !== undefined) found.push(gitnexus);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  return found;
};

const parseTomlString = (raw: string): string | null => {
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const codexMcpFingerprint = (raw: string): string | null => {
  const sectionMatch = raw.match(
    /(?:^|\n)\[mcp_servers\.gitnexus\]\s*\n([\s\S]*?)(?=\n\[(?!mcp_servers\.gitnexus\.env\])|$)/,
  );
  if (!sectionMatch) return null;
  const body = sectionMatch[1];
  const commandMatch = body.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m);
  if (!commandMatch) return null;
  const command = parseTomlString(commandMatch[1]);
  if (command === null) return null;
  const argsMatch = body.match(/^\s*args\s*=\s*(\[[^\n]*\])\s*$/m);
  let args: unknown = [];
  if (argsMatch) {
    try {
      args = JSON.parse(argsMatch[1]);
    } catch {
      return null;
    }
  }
  const env: Record<string, string> = {};
  const envMatch = raw.match(/(?:^|\n)\[mcp_servers\.gitnexus\.env\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (envMatch) {
    for (const line of envMatch[1].split('\n')) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const assignment = line.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*|"(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/,
      );
      if (!assignment) return null;
      const key = assignment[1].startsWith('"') ? parseTomlString(assignment[1]) : assignment[1];
      const value = parseTomlString(assignment[2]);
      if (key === null || value === null) return null;
      env[key] = value;
    }
  }
  return entryFingerprint({ command, args, env });
};

const hasCodexGitnexusSection = (raw: string): boolean =>
  /(?:^|\n)\[mcp_servers\.gitnexus\]\s*(?:\n|$)/.test(raw);

const gitnexusHookCommands = (hooks: unknown, eventName: string): string[] => {
  if (!hooks || typeof hooks !== 'object') return [];
  const entries = (hooks as Record<string, unknown>)[eventName];
  if (!Array.isArray(entries)) return [];
  const commands: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const nested = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(nested)) continue;
    for (const hook of nested) {
      if (!hook || typeof hook !== 'object') continue;
      const command = (hook as { command?: unknown }).command;
      if (
        typeof command === 'string' &&
        (command.includes('gitnexus-hook') ||
          (eventName === 'SessionStart' && command.includes('gitnexus session-context')))
      ) {
        commands.push(command);
      }
    }
  }
  return commands;
};

const claudeHookStatus = async (
  home: string,
): Promise<{
  status: HookStatus;
  obsoleteSessionStart: boolean;
}> => {
  const target = hookTarget('claude', home);
  const settingsRaw = await readOptional(target.settingsFile);
  if (settingsRaw === null) return { status: 'missing', obsoleteSessionStart: false };
  const errors: ParseError[] = [];
  const settings = parseJsonc(settingsRaw, errors);
  if (errors.length > 0 || !settings || typeof settings !== 'object') {
    return { status: 'missing', obsoleteSessionStart: false };
  }
  const hooks = (settings as { hooks?: unknown }).hooks;
  const obsoleteSessionStart = gitnexusHookCommands(hooks, 'SessionStart').length > 0;
  const preCommands = gitnexusHookCommands(hooks, 'PreToolUse');
  const postCommands = gitnexusHookCommands(hooks, 'PostToolUse');
  if (preCommands.length === 0 || postCommands.length === 0) {
    return { status: 'missing', obsoleteSessionStart };
  }

  const expectedHookPath = path.join(target.scriptDir, CLAUDE_HOOK_ADAPTER).replace(/\\/g, '/');
  const expectedCommand = formatHookCommand(expectedHookPath);
  if (
    preCommands.some((command) => command !== expectedCommand) ||
    postCommands.some((command) => command !== expectedCommand)
  ) {
    return { status: 'stale', obsoleteSessionStart };
  }

  const sourceDir = path.join(__dirname, '..', '..', 'hooks', 'claude');
  const cliPath = path.resolve(path.join(__dirname, '..', 'cli', 'index.js'));
  const freshnessFiles = [
    CLAUDE_HOOK_ADAPTER,
    ...CLAUDE_HOOK_HELPERS.filter((fileName) => !BEST_EFFORT_CLAUDE_HOOK_HELPERS.has(fileName)),
  ];
  for (const fileName of freshnessFiles) {
    const source = await readOptional(path.join(sourceDir, fileName));
    const installed = await readOptional(path.join(target.scriptDir, fileName));
    if (source === null || installed === null) return { status: 'missing', obsoleteSessionStart };
    const expected =
      fileName === CLAUDE_HOOK_ADAPTER ? patchClaudeHookCliPath(source, cliPath).content : source;
    if (digest(expected) !== digest(installed)) {
      return { status: 'stale', obsoleteSessionStart };
    }
  }
  return { status: 'current', obsoleteSessionStart };
};

export async function buildIntegrationDoctorReport(
  home: string = os.homedir(),
): Promise<IntegrationDoctorReport> {
  const targets = getEditorTargets(home);
  const claudeRaw = await readOptional(mcpTarget('claude', home).file);
  const codexRaw = await readOptional(targets.codex.configFile);
  let status: McpStatus = 'missing';
  let claudeEntries: unknown[] = [];
  let codexFingerprint: string | null = null;
  let invalid = false;

  if (claudeRaw !== null && claudeRaw.trim().length > 0) {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(claudeRaw, errors);
    invalid ||= errors.length > 0 || !parsed;
    if (!invalid) claudeEntries = collectClaudeMcpEntries(parsed);
  }
  if (codexRaw !== null) codexFingerprint = codexMcpFingerprint(codexRaw);

  const claudeFingerprints = claudeEntries.map(entryFingerprint);
  invalid ||=
    (claudeEntries.length > 0 && claudeFingerprints.some((fingerprint) => fingerprint === null)) ||
    (codexRaw !== null && hasCodexGitnexusSection(codexRaw) && codexFingerprint === null);
  if (invalid) {
    status = 'invalid';
  } else if (codexFingerprint && claudeFingerprints.length > 0) {
    status = claudeFingerprints.every((fingerprint) => fingerprint === codexFingerprint)
      ? 'consistent'
      : 'mismatch';
  }

  const hook = await claudeHookStatus(home);
  return {
    selectedCli: { version: pkg.version },
    mcp: {
      status,
      codexConfigured: codexFingerprint !== null,
      claudeConfiguredEntries: claudeEntries.length,
    },
    hooks: { claude: hook.status, obsoleteSessionStart: hook.obsoleteSessionStart },
  };
}
