import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('PR review exact-source fixture', () => {
  it('rejects a graph receipt from the other worktree and accepts the exact head', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-review-identity-'));
    temporaryRoots.push(root);
    const repository = path.join(root, 'repository');
    const headWorktree = path.join(root, 'head-worktree');
    fs.mkdirSync(repository);

    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.name', 'GitNexus Test']);
    git(repository, ['config', 'user.email', 'gitnexus-test@example.invalid']);
    fs.writeFileSync(path.join(repository, 'value.txt'), 'base\n');
    git(repository, ['add', 'value.txt']);
    git(repository, ['commit', '-m', 'base']);
    const baseSha = git(repository, ['rev-parse', 'HEAD']);

    git(repository, ['switch', '-c', 'feature']);
    fs.writeFileSync(path.join(repository, 'value.txt'), 'head\n');
    git(repository, ['commit', '-am', 'head']);
    const headSha = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['switch', 'main']);
    git(repository, ['worktree', 'add', '--detach', headWorktree, headSha]);

    const mergeBase = git(repository, ['merge-base', baseSha, headSha]);
    const diff = git(headWorktree, ['diff', `${mergeBase}..${headSha}`, '--', 'value.txt']);
    const worktreeHead = git(headWorktree, ['rev-parse', 'HEAD']);

    expect(diff).toContain('+head');
    expect(worktreeHead).toBe(headSha);

    const staleIndexReceipt = { repository, indexCommit: baseSha };
    expect(staleIndexReceipt.indexCommit).not.toBe(worktreeHead);

    const exactIndexReceipt = { repository, indexCommit: headSha };
    expect(exactIndexReceipt.indexCommit).toBe(worktreeHead);
    expect(mergeBase).toBe(baseSha);
  });
});
