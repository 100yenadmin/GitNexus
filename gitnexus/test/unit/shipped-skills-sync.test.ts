import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STANDARD_SKILL_CATALOG } from '../../scripts/standard-skill-catalog.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function canonical(name: string): string {
  return path.join(REPO_ROOT, '.claude', 'skills', name, 'SKILL.md');
}

function distributed(name: string): string[] {
  return [
    path.join(REPO_ROOT, 'gitnexus', 'skills', `${name}.md`),
    path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', name, 'SKILL.md'),
    path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills', name, 'SKILL.md'),
  ];
}

function skillNames(root: string, flat: boolean): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      flat
        ? entry.isFile() && entry.name.endsWith('.md')
        : entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')),
    )
    .map((entry) => (flat ? entry.name.slice(0, -3) : entry.name))
    .sort();
}

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return entry.isFile() ? [target] : [];
  });
}

function hasFloatingGitnexusNpx(line: string): boolean {
  const tokens = line
    .replace(/[`"'()[\]{},;]/g, ' ')
    .trim()
    .split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^npx(?:\.cmd)?$/i.test(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (/^--package=gitnexus(?:@[\w.-]+)?$/i.test(token)) return true;
      if (/^(?:--package|-p)$/i.test(token)) {
        return /^gitnexus(?:@[\w.-]+)?$/i.test(tokens[j + 1] || '');
      }
      if (token.startsWith('-')) continue;
      return /^gitnexus(?:@[\w.-]+)?$/i.test(token);
    }
  }
  return false;
}

describe('STANDARD_SKILL_CATALOG distribution', () => {
  const names = STANDARD_SKILL_CATALOG.map((entry) => entry.name).sort();
  const analyzeProjectSkills = STANDARD_SKILL_CATALOG.filter((entry) => entry.analyzeProject).map(
    (entry) => entry.name,
  );

  it('exactly covers npm, Claude plugin, and Cursor skill copies', () => {
    expect(skillNames(path.join(REPO_ROOT, 'gitnexus', 'skills'), true)).toEqual(names);
    expect(skillNames(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills'), false)).toEqual(
      names,
    );
    expect(
      skillNames(path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills'), false),
    ).toEqual(names);
  });

  it('keeps the existing six-skill analyze-time project install explicit', () => {
    expect(analyzeProjectSkills).toEqual([
      'gitnexus-cli',
      'gitnexus-debugging',
      'gitnexus-exploring',
      'gitnexus-guide',
      'gitnexus-impact-analysis',
      'gitnexus-refactoring',
    ]);
  });

  it.each(STANDARD_SKILL_CATALOG)(
    '$name is authored once and distributed byte-identically',
    ({ name }) => {
      const source = fs.readFileSync(canonical(name));
      for (const copy of distributed(name)) {
        expect(fs.readFileSync(copy), copy).toEqual(source);
      }
    },
  );

  it('keeps plugin MCP configuration separate from skill copies', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'gitnexus-claude-plugin', '.mcp.json'))).toBe(false);
    for (const { name } of STANDARD_SKILL_CATALOG) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', name, 'mcp.json')),
      ).toBe(false);
    }
    for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const value = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'gitnexus-claude-plugin', manifest), 'utf8'),
      );
      expect(value).not.toHaveProperty('mcpServers');
    }
  });

  it('keeps versions and Electric fork provenance aligned', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'gitnexus', 'package.json'), 'utf8'),
    );
    expect(packageJson.version).toBe('1.6.10-electric.10');
    expect(packageJson.repository.url).toContain('electricsheephq/evaOS-gitnexus');
    expect(packageJson.homepage).toContain('electricsheephq/evaOS-gitnexus');
    expect(packageJson.bugs.url).toContain('electricsheephq/evaOS-gitnexus');

    for (const file of [
      'gitnexus-claude-plugin/.claude-plugin/plugin.json',
      'gitnexus-claude-plugin/.codex-plugin/plugin.json',
    ]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      expect(manifest.version).toBe(packageJson.version);
      expect(manifest.repository).toContain('electricsheephq/evaOS-gitnexus');
      expect(JSON.stringify(manifest)).not.toContain('gitnexus@latest');
    }

    for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
      const marketplace = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      const plugin = marketplace.plugins.find(
        (entry: { name?: string }) => entry.name === 'gitnexus',
      );
      expect(plugin?.version).toBe(packageJson.version);
      expect(JSON.stringify(marketplace)).not.toContain('gitnexus@latest');
    }
  });

  it('rejects floating package references from distributed MCP guidance', () => {
    const guidance = new Set([
      path.join(REPO_ROOT, 'README.md'),
      path.join(REPO_ROOT, 'AGENTS.md'),
      path.join(REPO_ROOT, 'CLAUDE.md'),
      path.join(REPO_ROOT, '.devcontainer', 'README.md'),
      path.join(REPO_ROOT, 'gitnexus', 'README.md'),
      path.join(REPO_ROOT, 'Documentation', 'kilo-code-mcp.md'),
      path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'README.md'),
      ...STANDARD_SKILL_CATALOG.flatMap(({ name }) => [canonical(name), ...distributed(name)]),
      ...filesUnder(path.join(REPO_ROOT, 'gitnexus', 'src')),
      ...filesUnder(path.join(REPO_ROOT, 'gitnexus', 'hooks')),
      ...filesUnder(path.join(REPO_ROOT, 'gitnexus-web', 'src')),
      ...filesUnder(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'hooks')),
      ...filesUnder(path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'hooks')),
    ]);
    for (const file of guidance) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toContain('gitnexus@latest');
      expect(text, file).not.toMatch(/\bgitnexus@rc\b/);
      expect(
        text.split(/\r?\n/).some((line) => hasFloatingGitnexusNpx(line)),
        file,
      ).toBe(false);
      expect(text, file).not.toMatch(/\bpnpm(?:\s+\S+)*\s+dlx\s+gitnexus(?:@[\w.-]+)?\b/);
      expect(text, file).not.toMatch(
        /\bnpm\s+(?:i|install)\s+(?:--global|-g)\s+gitnexus(?:@[\w.-]+)?\b/,
      );
    }
  });

  it('recognizes option-bearing floating npx launchers without rejecting exact URLs', () => {
    for (const sample of [
      'npx gitnexus',
      'npx -y gitnexus',
      'npx --yes gitnexus',
      'npx --package gitnexus gitnexus',
      'npx --package=gitnexus@1.2.3 gitnexus',
    ]) {
      expect(hasFloatingGitnexusNpx(sample), sample).toBe(true);
    }
    expect(
      hasFloatingGitnexusNpx(
        'npx -y https://github.com/electricsheephq/evaOS-gitnexus/releases/download/electric%2Fv1.6.10-electric.10/gitnexus-1.6.10-electric.10.tgz mcp',
      ),
    ).toBe(false);
  });
});

describe('narrow electric skill contracts', () => {
  it('binds PR review source and graph identity', () => {
    const text = fs.readFileSync(canonical('gitnexus-pr-review'), 'utf8');
    for (const fragment of [
      'Base SHA:',
      'Head SHA:',
      'Merge base:',
      'Worktree:',
      'GitNexus index commit:',
      'The repository, worktree head, diff head, and graph index commit',
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).not.toContain('Expert lenses');
    expect(text).not.toContain('Swarm lanes');
  });

  it('documents lower-bound and degraded impact semantics', () => {
    const text = fs.readFileSync(canonical('gitnexus-impact-analysis'), 'utf8');
    expect(text).toContain('lower-bound graph heuristic');
    expect(text).toContain('`UNKNOWN` is not a low rung');
    expect(text).toContain('`pagination.truncated: true`');
    expect(text).toContain('HIGH or CRITICAL');
    expect(text).toContain('untracked files');
    expect(text).not.toContain('WILL BREAK');
  });

  it('documents rename transaction and untracked-file limits', () => {
    const text = fs.readFileSync(canonical('gitnexus-refactoring'), 'utf8');
    expect(text).toContain('not an immutable transaction');
    expect(text).toContain('`rename` does not accept `worktree`');
    expect(text).toContain('Require a clean worktree');
    expect(text).toContain('untracked files');
    expect(text).toContain('`status: "partial"`');
    expect(text).toContain('`failed_files`');
  });

  it('keeps PDG examples anchored and bounded', () => {
    const text = fs.readFileSync(canonical('gitnexus-pdg-query'), 'utf8');
    expect(text).toContain('pdg_query({');
    expect(text).toContain('target: "validateUser"');
    expect(text).toContain('limit: 50');
    expect(text).toContain('LIMIT 50');
  });

  it('uses current taint model paths and LadybugDB terminology', () => {
    const text = fs.readFileSync(canonical('gitnexus-taint-analysis'), 'utf8');
    expect(text).toContain('taint/python-model.ts');
    expect(text).toContain('taint/java-model.ts');
    expect(text).toContain('not exact symbol identity');
    expect(text).toContain('LadybugDB');
    expect(text).not.toContain('Kuzu');
  });

  it('documents MCP resources, embedding variables, and side effects', () => {
    const guide = fs.readFileSync(canonical('gitnexus-guide'), 'utf8');
    const cli = fs.readFileSync(canonical('gitnexus-cli'), 'utf8');
    for (const resource of [
      'gitnexus://repos',
      'gitnexus://setup',
      'gitnexus://group/{name}/contracts',
      'gitnexus://group/{name}/status',
    ]) {
      expect(guide).toContain(resource);
    }
    expect(guide).toContain('`group_sync` rebuilds');
    expect(cli).toContain('GITNEXUS_EMBEDDING_API_KEY');
    expect(cli).toContain('`--index-only` still updates');
    expect(cli).toContain('public, account-visible write');
    expect(cli).not.toContain('gitnexus@latest');
  });
});
