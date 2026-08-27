import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-lock.cjs');
const pluginHelperPath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'hook-lock.js',
);

describe('Claude hook machine-global concurrency cap', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('admits no more than eight of 64 simultaneous calls across repositories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-global-cap-'));
    roots.push(root);
    const globalDir = path.join(root, 'global-locks');
    const readyDir = path.join(root, 'ready');
    const startGate = path.join(root, 'start');
    fs.mkdirSync(readyDir);
    const repos = Array.from({ length: 24 }, (_, index) => {
      const gitnexusDir = path.join(root, `repo-${index}`, '.gitnexus');
      fs.mkdirSync(gitnexusDir, { recursive: true });
      return gitnexusDir;
    });
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { acquireHookSlot } = require(${JSON.stringify(helperPath)});
      fs.writeFileSync(path.join(process.argv[2], String(process.pid)), 'ready');
      const waitForGate = () => {
        if (!fs.existsSync(process.argv[3])) { setTimeout(waitForGate, 10); return; }
        const release = acquireHookSlot(process.argv[1]);
        if (!release) { process.stdout.write('denied\\n'); return; }
        process.stdout.write('acquired\\n');
        setTimeout(() => { release(); }, 2000);
      };
      waitForGate();
    `;

    const outcomePromises: Array<Promise<string>> = [];
    for (let index = 0; index < 64; index++) {
      const child = spawn(
        process.execPath,
        ['-e', script, repos[index % repos.length], readyDir, startGate],
        {
          env: { ...process.env, GITNEXUS_HOOK_GLOBAL_LOCK_DIR: globalDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      outcomePromises.push(
        new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr.on('data', (chunk) => (stderr += String(chunk)));
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
            else resolve(stdout.trim());
          });
        }),
      );
    }

    const readyDeadline = Date.now() + 15_000;
    while (fs.readdirSync(readyDir).length < 64 && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.readdirSync(readyDir)).toHaveLength(64);
    fs.writeFileSync(startGate, 'go');

    const outcomes = await Promise.all(outcomePromises);

    const acquired = outcomes.filter((outcome) => outcome === 'acquired').length;
    expect(acquired).toBeGreaterThan(0);
    expect(acquired).toBeLessThanOrEqual(8);
    expect(outcomes.filter((outcome) => outcome === 'denied')).toHaveLength(64 - acquired);
    const remainingLocks = fs.existsSync(globalDir)
      ? fs.readdirSync(globalDir).filter((entry) => entry.endsWith('.lock'))
      : [];
    expect(remainingLocks).toEqual([]);
    for (const repo of repos) {
      const perRepo = path.join(repo, '.hook-locks');
      const orphaned = fs.existsSync(perRepo)
        ? fs.readdirSync(perRepo).filter((entry) => entry.endsWith('.lock'))
        : [];
      expect(orphaned).toEqual([]);
    }
  }, 30_000);

  it('applies the same eight-slot global cap to the standalone Claude plugin helper', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-plugin-hook-global-cap-'));
    roots.push(root);
    const globalDir = path.join(root, 'global-locks');
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { acquireHookSlot } = require(${JSON.stringify(pluginHelperPath)});
      const releases = [];
      for (let index = 0; index < 9; index++) {
        const repo = path.join(process.argv[1], 'repo-' + index, '.gitnexus');
        fs.mkdirSync(repo, { recursive: true });
        const release = acquireHookSlot(repo);
        if (release) releases.push(release);
      }
      process.stdout.write(String(releases.length));
      for (const release of releases) release();
    `;
    const outcome = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, root], {
        env: { ...process.env, GITNEXUS_HOOK_GLOBAL_LOCK_DIR: globalDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
        else resolve(stdout.trim());
      });
    });

    expect(outcome).toBe('8');
    expect(fs.readdirSync(globalDir).filter((entry) => entry.endsWith('.lock'))).toEqual([]);
  });
});
