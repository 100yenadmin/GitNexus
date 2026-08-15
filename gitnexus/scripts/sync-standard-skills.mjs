#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_SKILL_CATALOG } from './standard-skill-catalog.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');

function parseArgs(argv) {
  let check = false;
  let repoRoot = DEFAULT_REPO_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--repo-root' && argv[index + 1]) {
      repoRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error('usage: sync-standard-skills.mjs [--check] [--repo-root <path>]');
  }
  return { check, repoRoot };
}

function pathsFor(repoRoot, entry) {
  const targets = [];
  if (entry.distributions.npm) {
    targets.push(path.join(repoRoot, 'gitnexus', 'skills', `${entry.name}.md`));
  }
  if (entry.distributions.claudePlugin) {
    targets.push(path.join(repoRoot, 'gitnexus-claude-plugin', 'skills', entry.name, 'SKILL.md'));
  }
  if (entry.distributions.cursor) {
    targets.push(
      path.join(repoRoot, 'gitnexus-cursor-integration', 'skills', entry.name, 'SKILL.md'),
    );
  }
  return {
    canonical: path.join(repoRoot, '.claude', 'skills', entry.name, 'SKILL.md'),
    targets,
  };
}

async function readFileOrThrow(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`required skill file is missing or unreadable: ${filePath}`, {
      cause: error,
    });
  }
}

async function assertSkillsOnlyPlugin(repoRoot) {
  const pluginRoot = path.join(repoRoot, 'gitnexus-claude-plugin');
  const forbidden = [
    path.join(pluginRoot, '.mcp.json'),
    ...STANDARD_SKILL_CATALOG.map((entry) =>
      path.join(pluginRoot, 'skills', entry.name, 'mcp.json'),
    ),
  ];
  for (const filePath of forbidden) {
    try {
      await fs.access(filePath);
      throw new Error(`skills/hooks-only plugin must not ship MCP config: ${filePath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  for (const manifestName of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const filePath = path.join(pluginRoot, manifestName);
    const manifest = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if ('mcpServers' in manifest) {
      throw new Error(`skills/hooks-only plugin manifest must omit mcpServers: ${filePath}`);
    }
  }
}

async function main() {
  const { check, repoRoot } = parseArgs(process.argv.slice(2));
  const mismatches = [];

  for (const entry of STANDARD_SKILL_CATALOG) {
    const { canonical, targets } = pathsFor(repoRoot, entry);
    const content = await readFileOrThrow(canonical);
    for (const target of targets) {
      if (check) {
        const shipped = await readFileOrThrow(target);
        if (!content.equals(shipped)) mismatches.push(path.relative(repoRoot, target));
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }

  await assertSkillsOnlyPlugin(repoRoot);
  if (mismatches.length > 0) {
    throw new Error(`skill copies differ from canonical source: ${mismatches.join(', ')}`);
  }

  process.stdout.write(
    check
      ? `Verified ${STANDARD_SKILL_CATALOG.length} canonical skills and skills/hooks-only plugin provenance.\n`
      : `Synchronized ${STANDARD_SKILL_CATALOG.length} canonical skills.\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sync-standard-skills: ${message}\n`);
  process.exitCode = 1;
});
