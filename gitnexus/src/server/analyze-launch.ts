/**
 * Shared analyze-worker launcher.
 *
 * Forks the analyze worker for an already-resolved repo directory and owns the
 * lock + auto-retry + IPC machinery. Used by both the JSON `/api/analyze` route
 * and the multipart `/api/analyze/upload` route. Dependency-injected (like
 * createAnalyzeUploadHandler) so the seam is testable and api.ts stays smaller.
 *
 * NOTE: this module must live alongside analyze-worker.{ts,js} — the worker
 * path is resolved relative to `import.meta.url`.
 */

import path from 'path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import {
  canonicalizePath,
  canonicalRepoLockKey,
  canonicalRepoRootLockKey,
  getStoragePath,
  INDEX_METADATA_FILE,
} from '../storage/repo-manager.js';
import { logger } from '../core/logger.js';
import type { JobManager } from './analyze-job.js';
import type { WorkerMessage } from './analyze-worker.js';
import type { AnalyzeResultIpc } from './analyze-worker-ipc.js';

const _require = createRequire(import.meta.url);

export interface LaunchDeps {
  jobManager: JobManager;
  backend: { init: () => Promise<unknown> };
  acquireRepoLock: (...keys: string[]) => string | null;
  releaseRepoLock: (...keys: string[]) => void;
  acquireAnalyzeOwnership: (
    storagePath: string,
    repoRoot: string,
  ) => Promise<{ release(): Promise<void> }>;
  /**
   * Drops the server's cached LadybugDB handle (closeLbug). The worker
   * process rewrites the repo's DB files on disk, so a connection opened
   * before the rewrite keeps reading the pre-rewrite state until evicted.
   */
  closeDbHandle: () => Promise<void>;
}

export interface LaunchOptions {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
  registryName?: string;
}

const MAX_WORKER_RETRIES = 2;

const RECOVERY_ONLY_ERROR =
  'Recovered a previous staged promotion, but the current checkout was not analyzed. ' +
  'Start a new analysis with force=true and dropEmbeddings=true ' +
  '(CLI: `gitnexus analyze --staged --drop-embeddings`).';

/**
 * Translate the worker's successful terminal result into the server job
 * contract. Recovery-only is deliberately a failed analyze request: the prior
 * promotion is durable, but reporting ordinary completion would claim that the
 * current checkout was indexed when it was not.
 */
export const completionUpdateForWorkerResult = (
  result: AnalyzeResultIpc,
): { status: 'complete' | 'failed'; repoName: string; error?: string } =>
  result.recoveredPromotionOnly
    ? { status: 'failed', repoName: result.repoName, error: RECOVERY_ONLY_ERROR }
    : { status: 'complete', repoName: result.repoName };

/**
 * The worker reports `complete` over IPC before its on-disk finalization
 * (LadybugDB checkpoint + native handle release + metadata write) is visible
 * at `getStoragePath(targetPath)` — observed up to ~6.5s behind the IPC
 * message. Opening the database inside that window is what the pre-IPC
 * ordering was meant to prevent and is actively dangerous: reads fail with
 * binder errors or return an empty graph, the open can quarantine the
 * in-flight WAL, and the native layer racing the rewrite has crashed the
 * whole server (SIGSEGV-class exit, no output) on slow CI runners.
 */
const FINALIZE_SETTLE_TIMEOUT_MS = 60_000;
const FINALIZE_SETTLE_POLL_MS = 200;

/**
 * Resolve once the analyzed repo's index is settled at `storagePath`: the
 * LadybugDB file and metadata both exist AND were (re)written by THIS job
 * (mtime >= jobStartMs — bare existence is not enough, a re-analysis leaves
 * the previous index in place while it works), and no transient WAL/shadow/
 * checkpoint sidecars remain (the worker's native close has finished).
 *
 * Never rejects. Timing out logs and proceeds (pre-gate behavior) rather
 * than failing a job whose analysis genuinely succeeded — e.g. a no-op
 * non-force analyze legitimately rewrites nothing.
 */
/**
 * Probe only the physical storage target captured before lock acquisition.
 * Re-resolving a repository or registry symlink here could observe a retarget
 * and wait on storage the worker never owned.
 */
const waitForSettledIndex = async (storagePath: string, jobStartMs: number): Promise<void> => {
  const settled = (storagePath: string): boolean => {
    try {
      const lbugStat = statSync(path.join(storagePath, 'lbug'));
      const metaStat = statSync(path.join(storagePath, INDEX_METADATA_FILE));
      return (
        lbugStat.mtimeMs >= jobStartMs &&
        metaStat.mtimeMs >= jobStartMs &&
        ['lbug.wal', 'lbug.shadow', 'lbug.wal.checkpoint'].every(
          (f) => !existsSync(path.join(storagePath, f)),
        )
      );
    } catch {
      return false; // not written yet
    }
  };
  const deadline = Date.now() + FINALIZE_SETTLE_TIMEOUT_MS;
  for (;;) {
    if (settled(storagePath)) return;
    if (Date.now() > deadline) {
      logger.warn(
        { storagePath },
        'analyze finalization not visible after timeout; completing job anyway',
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FINALIZE_SETTLE_POLL_MS));
  }
};

export function createLaunchAnalysisWorker(deps: LaunchDeps) {
  const {
    jobManager,
    backend,
    acquireRepoLock,
    releaseRepoLock,
    acquireAnalyzeOwnership,
    closeDbHandle,
  } = deps;

  return function launchAnalysisWorker(
    job: { id: string },
    targetPath: string,
    opts: LaunchOptions,
  ): void {
    // For waitForSettledIndex: files (re)written by this job have mtimes at or
    // after this instant. Taken before the fork so no worker write predates it.
    const jobStartMs = Date.now();
    // Capture the canonical lock key before the worker can remove or retarget
    // the repository root. The same physical root is sent to every retry so a
    // later symlink retarget cannot move the worker outside the held lock.
    const lockedRepoPath = canonicalizePath(targetPath);
    const analyzeRootLockKey = canonicalRepoRootLockKey(lockedRepoPath);
    const rootLockErr = acquireRepoLock(analyzeRootLockKey);
    if (rootLockErr) {
      jobManager.updateJob(job.id, { status: 'failed', error: rootLockErr });
      return;
    }
    const lexicalStoragePath = getStoragePath(lockedRepoPath);
    let analyzeStorageLockKey = canonicalRepoLockKey(lockedRepoPath);
    let ownershipLease: { release(): Promise<void> } | undefined;
    let storageLockHeld = false;
    let lockReleased = false;
    const releaseLock = async (): Promise<void> => {
      if (lockReleased) return;
      lockReleased = true;
      try {
        await ownershipLease?.release();
      } finally {
        releaseRepoLock(
          ...(storageLockHeld ? [analyzeStorageLockKey, analyzeRootLockKey] : [analyzeRootLockKey]),
        );
      }
    };
    let terminalMessageReceived = false;

    const failSynchronousLaunch = async (err: unknown): Promise<void> => {
      const message = err instanceof Error ? err.message : String(err);
      let releaseError: unknown;
      try {
        await releaseLock();
      } catch (releaseErr) {
        releaseError = releaseErr;
      }
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: releaseError
          ? `Worker process error: ${message}; analyze ownership release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
          : `Worker process error: ${message}`,
      });
    };

    // ── Worker fork with auto-retry ──────────────────────────────
    const callerPath = fileURLToPath(import.meta.url);
    const isDev = callerPath.endsWith('.ts');
    const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
    const workerPath = path.join(path.dirname(callerPath), workerFile);
    const tsxHookArgs: string[] = isDev
      ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
      : [];

    const forkWorker = () => {
      const currentJob = jobManager.getJob(job.id);
      if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') {
        void releaseLock().catch((err) => {
          logger.error({ err }, 'analyze ownership release failed after terminal job:');
        });
        return;
      }

      const child = fork(workerPath, [], {
        execArgv: [...tsxHookArgs, '--max-old-space-size=8192'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let childExited = false;
      let terminalCleanupStarted = false;
      let terminalCleanupComplete = false;
      let finalizationStarted = false;
      let terminalUpdate:
        | { status: 'complete' | 'failed'; repoName?: string; error?: string }
        | undefined;
      const maybeReleaseAfterTerminalCleanup = (): void => {
        if (!childExited || !terminalCleanupComplete || finalizationStarted) return;
        finalizationStarted = true;
        void releaseLock()
          .then(() => {
            if (terminalUpdate) jobManager.updateJob(job.id, terminalUpdate);
          })
          .catch((err) => {
            logger.error({ err }, 'analyze ownership release failed after worker finalization:');
            jobManager.updateJob(job.id, {
              status: 'failed',
              error: `Analyze ownership release failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
      };
      const finishTerminalCleanup = (cleanup: Promise<unknown>): void => {
        if (terminalCleanupStarted) return;
        terminalCleanupStarted = true;
        void cleanup
          .catch(() => {})
          .then(() => {
            terminalCleanupComplete = true;
            maybeReleaseAfterTerminalCleanup();
          });
      };

      // Capture stderr for crash diagnostics
      let stderrChunks = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks += chunk.toString();
        if (stderrChunks.length > 4096) stderrChunks = stderrChunks.slice(-4096);
      });

      child.on('message', (msg: WorkerMessage) => {
        // Ignore any message once the job is terminal — a late worker message (a
        // SIGTERM-driven `error` after `complete`, or vice versa) must not
        // re-release the repo lock or flip the reported status. Mirrors the `exit`
        // handler guard below; pairs with the worker's terminal-claim (#2264 P3).
        const current = jobManager.getJob(job.id);
        if (
          !current ||
          current.status === 'complete' ||
          current.status === 'failed' ||
          terminalMessageReceived
        ) {
          return;
        }

        if (msg.type === 'progress') {
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
          });
        } else if (msg.type === 'complete') {
          terminalMessageReceived = true;
          // Before recording the terminal result: (1) wait for the worker's on-disk
          // finalization to settle (see waitForSettledIndex), (2) evict the
          // cached DB handle — same invalidation DELETE /api/repo performs, a
          // handle opened before the rewrite reads pre-rewrite state — and
          // only then (3) reinitialize the backend. This makes the ordering
          // comment below true in practice: the repo is actually queryable
          // when the client receives the SSE complete event.
          // A recovery-only result may merely clean a committed journal without
          // rewriting the canonical DB/meta, so the normal mtime gate cannot
          // prove this job's write and would wait the full timeout. The worker
          // has already completed the journal transaction; evict/reload now,
          // then fail the analyze request with explicit retry guidance.
          const settle = msg.result.recoveredPromotionOnly
            ? Promise.resolve()
            : waitForSettledIndex(analyzeStorageLockKey, jobStartMs);
          finishTerminalCleanup(
            settle
              .then(() => closeDbHandle())
              .catch(() => {}) // best-effort: eviction failure must not fail the job
              .then(() => backend.init())
              .then(() => {
                terminalUpdate = completionUpdateForWorkerResult(msg.result);
              })
              .catch((err) => {
                logger.error({ err }, 'backend.init() failed after analyze:');
                terminalUpdate = {
                  status: 'failed',
                  error: 'Server failed to reload after analysis. Try again.',
                };
              }),
          );
        } else if (msg.type === 'error') {
          terminalMessageReceived = true;
          terminalUpdate = { status: 'failed', error: msg.message };
          // A failed (force) analyze may still have rewritten DB files first.
          finishTerminalCleanup(closeDbHandle());
        }
      });

      child.on('error', (err) => {
        const current = jobManager.getJob(job.id);
        // Cancellation marks the job failed before the child has finished its
        // bounded shutdown checkpoint. Its exit event owns release in that case.
        if (
          !current ||
          current.status === 'complete' ||
          current.status === 'failed' ||
          terminalMessageReceived
        ) {
          return;
        }
        terminalMessageReceived = true;
        terminalUpdate = {
          status: 'failed',
          error: `Worker process error: ${err.message}`,
        };
        finishTerminalCleanup(closeDbHandle());
        // An error event does not prove process exit (IPC and kill failures can
        // emit it while the child is still alive). Retain the repository lock
        // until `close`, and request termination so no analyzer survives the
        // failed parent-side channel.
        try {
          child.kill('SIGTERM');
        } catch {}
      });

      // `close` follows actual process termination (and also a failed spawn)
      // after the stdio handles are closed. It is the sole event allowed to
      // prove the child can no longer touch repository storage.
      child.on('close', (code) => {
        const j = jobManager.getJob(job.id);
        childExited = true;
        if (!j || j.status === 'complete' || j.status === 'failed') {
          finishTerminalCleanup(closeDbHandle());
          maybeReleaseAfterTerminalCleanup();
          return;
        }
        if (terminalMessageReceived) {
          maybeReleaseAfterTerminalCleanup();
          return;
        }

        // Worker crashed — attempt retry if under the limit
        if (j.retryCount < MAX_WORKER_RETRIES) {
          j.retryCount++;
          const delay = 1000 * Math.pow(2, j.retryCount - 1); // 1s, 2s
          const lastErr = stderrChunks.trim().split('\n').pop() || '';
          logger.warn(
            `Analyze worker crashed (code ${code}), retry ${j.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
              (lastErr ? `: ${lastErr}` : ''),
          );
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: {
              phase: 'retrying',
              percent: j.progress.percent,
              message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
            },
          });
          stderrChunks = '';
          setTimeout(() => {
            try {
              forkWorker();
            } catch (err) {
              failSynchronousLaunch(err);
            }
          }, delay);
        } else {
          // Exhausted retries — permanent failure
          terminalMessageReceived = true;
          terminalUpdate = {
            status: 'failed',
            error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
          };
          finishTerminalCleanup(closeDbHandle());
        }
      });

      try {
        // Register child for cancellation + timeout tracking
        jobManager.registerChild(job.id, child);

        // Send start command to child
        child.send({
          type: 'start',
          repoPath: lockedRepoPath,
          parentAnalyzeOwnershipHeld: true,
          options: {
            registryPath: targetPath,
            // Keep every analyzer filesystem write on the same physical
            // storage target whose shared repository lock is held. The repo's
            // lexical `.gitnexus` path may be retargeted after acquisition.
            analyzeStoragePath: analyzeStorageLockKey,
            force: !!opts.force,
            embeddings: !!opts.embeddings,
            dropEmbeddings: !!opts.dropEmbeddings,
            ...(opts.registryName ? { registryName: opts.registryName } : {}),
          },
        });
      } catch (err) {
        // A child may exist even when IPC setup/send fails synchronously. Do
        // not release the shared repository lock until `close` proves it can
        // no longer analyze.
        terminalMessageReceived = true;
        const message = err instanceof Error ? err.message : String(err);
        terminalUpdate = {
          status: 'failed',
          error: `Worker process error: ${message}`,
        };
        finishTerminalCleanup(closeDbHandle());
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    };

    void (async () => {
      try {
        ownershipLease = await acquireAnalyzeOwnership(analyzeStorageLockKey, lockedRepoPath);
        const currentJob = jobManager.getJob(job.id);
        if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') {
          await releaseLock();
          return;
        }
        if (existsSync(lockedRepoPath) && !existsSync(lexicalStoragePath)) {
          // The cross-process companion is already held, so first-analysis
          // storage cannot race DELETE between materialization and worker start.
          mkdirSync(lexicalStoragePath, { recursive: true });
        }
        // Storage may have been absent when ownership admission began, then
        // materialized as a symlink while the companion was pending. Re-freeze
        // its physical identity only after admission and carry that one target
        // through the local lock, worker, finalization, and release paths.
        analyzeStorageLockKey = canonicalRepoLockKey(lockedRepoPath);
        const storageLockErr = acquireRepoLock(analyzeStorageLockKey);
        if (storageLockErr) throw new Error(storageLockErr);
        storageLockHeld = true;
        jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });
        forkWorker();
      } catch (err) {
        await failSynchronousLaunch(err);
      }
    })();
  };
}
