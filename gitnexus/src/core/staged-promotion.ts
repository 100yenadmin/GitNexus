import { createHash, randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { retryRename } from '../storage/fs-atomic.js';
import {
  canonicalizePath,
  getGlobalDir,
  isMissingFilesystemError,
  loadMeta,
  saveMeta,
  INDEX_METADATA_FILE,
  type RepoMeta,
} from '../storage/repo-manager.js';

const STAGE_MANIFEST_SCHEMA = 'gitnexus.staged-analyze/v1';
const STAGE_INTENT_SCHEMA = 'gitnexus.staged-analyze-intent/v1';
const PROMOTION_JOURNAL_SCHEMA = 'gitnexus.staged-promotion/v1';
const DB_SIDECARS = ['.wal', '.shadow', '.wal.checkpoint'] as const;

export type PromotionState =
  | 'prepared'
  | 'old-backed-up'
  | 'new-installed'
  | 'metadata/registry-committed';

export type PromotionBoundary = PromotionState;

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface MetaIdentity {
  lastCommit: string;
  indexedAt: string;
}

interface MetaFilesIdentity {
  primary?: FileIdentity;
  legacy?: FileIdentity;
}

export interface RepositorySourceIdentity {
  head: string;
  branch: string | null;
}

interface StageManifest {
  schema: typeof STAGE_MANIFEST_SCHEMA;
  generationId: string;
  createdAt: string;
  sourceMeta?: MetaIdentity;
  sourceMetaFiles?: MetaFilesIdentity;
  sourceDb?: FileIdentity;
  sourceRepo?: RepositorySourceIdentity;
}

interface StageIntent extends Omit<StageManifest, 'schema' | 'sourceMetaFiles' | 'sourceRepo'> {
  schema: typeof STAGE_INTENT_SCHEMA;
  sourceMetaFiles: MetaFilesIdentity;
  sourceRepo: RepositorySourceIdentity;
}

interface PromotionJournal {
  schema: typeof PROMOTION_JOURNAL_SCHEMA;
  generationId: string;
  state: PromotionState;
  updatedAt: string;
  hadCanonical: boolean;
  stagedMeta: MetaIdentity;
  stagedDb: FileIdentity;
  oldDb?: FileIdentity;
  sourceMeta?: MetaIdentity;
  sourceMetaFiles?: MetaFilesIdentity;
  sourceDb?: FileIdentity;
  sourceRepo?: RepositorySourceIdentity;
  projectName?: string;
}

export interface StagedAnalyzePaths {
  canonicalLbugPath: string;
  canonicalMetaDir: string;
  stageRoot: string;
  stageIntentPath: string;
  stagedLbugPath: string;
  stagedMetaDir: string;
  stageManifestPath: string;
  backupLbugPath: string;
  journalPath: string;
}

export interface PromotionHooks {
  /** Test-only crash-injection seam after a durable state transition. */
  afterBoundary?: (boundary: PromotionBoundary) => void | Promise<void>;
  /** Fresh repository identity, read immediately before promotion transitions. */
  readRepositoryIdentity?: () => RepositorySourceIdentity | Promise<RepositorySourceIdentity>;
}

export interface PrepareStagedHooks {
  /** Test-only crash seam after mutable stage files exist but before the manifest. */
  afterStagePrepared?: () => void | Promise<void>;
}

export interface PromotionResult {
  projectName?: string;
  recovered: boolean;
}

interface StageLockRecord {
  schema: 'gitnexus.staged-analyze-lock/v1';
  pid: number;
  nonce: string;
  startedAt: string;
}

const metaIdentity = (meta: RepoMeta): MetaIdentity => ({
  lastCommit: meta.lastCommit,
  indexedAt: meta.indexedAt,
});

const identitiesEqual = <T>(a?: T, b?: T): boolean =>
  a === undefined ? b === undefined : b !== undefined && JSON.stringify(a) === JSON.stringify(b);

const validRepositoryIdentity = (value: unknown): value is RepositorySourceIdentity => {
  const candidate = value as Partial<RepositorySourceIdentity> | null;
  return (
    !!candidate &&
    typeof candidate.head === 'string' &&
    (candidate.branch === null || typeof candidate.branch === 'string')
  );
};

const validFileIdentity = (value: unknown): value is FileIdentity => {
  const candidate = value as Partial<FileIdentity> | null;
  return (
    !!candidate &&
    Number.isFinite(candidate.dev) &&
    Number.isFinite(candidate.ino) &&
    Number.isFinite(candidate.size) &&
    Number.isFinite(candidate.mtimeMs)
  );
};

const validMetaFilesIdentity = (value: unknown): value is MetaFilesIdentity => {
  const candidate = value as MetaFilesIdentity | null;
  return (
    !!candidate &&
    (candidate.primary === undefined || validFileIdentity(candidate.primary)) &&
    (candidate.legacy === undefined || validFileIdentity(candidate.legacy))
  );
};

const statRegularFile = async (filePath: string): Promise<FileIdentity | undefined> => {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`Expected a regular file at ${filePath}`);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (isMissingFilesystemError(error)) return undefined;
    throw error;
  }
};

const statMetadataFiles = async (metaDir: string): Promise<MetaFilesIdentity> => ({
  primary: await statRegularFile(path.join(metaDir, INDEX_METADATA_FILE)),
  legacy: await statRegularFile(path.join(metaDir, 'meta.json')),
});

const assertNoDbSidecars = async (lbugPath: string, label: string): Promise<void> => {
  const present: string[] = [];
  for (const suffix of DB_SIDECARS) {
    try {
      await fs.lstat(`${lbugPath}${suffix}`);
      present.push(`${lbugPath}${suffix}`);
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  }
  if (present.length > 0) {
    throw new Error(
      `${label} has unresolved LadybugDB sidecars (${present.join(', ')}); ` +
        'refusing staged copy or promotion until WAL/shadow state is resolved.',
    );
  }
};

const syncDirectory = async (dir: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const writeDurableJson = async (target: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await retryRename(temp, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

const readJson = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (isMissingFilesystemError(error)) return undefined;
    throw new Error(`Cannot read staged-analyze state at ${filePath}`, { cause: error });
  }
};

const isPromotionState = (value: unknown): value is PromotionState =>
  value === 'prepared' ||
  value === 'old-backed-up' ||
  value === 'new-installed' ||
  value === 'metadata/registry-committed';

const readManifest = async (paths: StagedAnalyzePaths): Promise<StageManifest | undefined> => {
  const manifest = await readJson<StageManifest>(paths.stageManifestPath);
  if (!manifest) return undefined;
  if (
    manifest.schema !== STAGE_MANIFEST_SCHEMA ||
    typeof manifest.generationId !== 'string' ||
    manifest.generationId.length < 8 ||
    (manifest.sourceMetaFiles !== undefined && !validMetaFilesIdentity(manifest.sourceMetaFiles)) ||
    (manifest.sourceRepo !== undefined && !validRepositoryIdentity(manifest.sourceRepo))
  ) {
    throw new Error('Staged-analyze manifest is corrupt or from an unsupported version');
  }
  return manifest;
};

const readIntent = async (paths: StagedAnalyzePaths): Promise<StageIntent | undefined> => {
  const intent = await readJson<StageIntent>(paths.stageIntentPath);
  if (!intent) return undefined;
  if (
    intent.schema !== STAGE_INTENT_SCHEMA ||
    typeof intent.generationId !== 'string' ||
    intent.generationId.length < 8 ||
    !validMetaFilesIdentity(intent.sourceMetaFiles) ||
    !validRepositoryIdentity(intent.sourceRepo)
  ) {
    throw new Error('Staged-analyze intent is corrupt or from an unsupported version');
  }
  return intent;
};

const readJournal = async (paths: StagedAnalyzePaths): Promise<PromotionJournal | undefined> => {
  const journal = await readJson<PromotionJournal>(paths.journalPath);
  if (!journal) return undefined;
  if (
    journal.schema !== PROMOTION_JOURNAL_SCHEMA ||
    typeof journal.generationId !== 'string' ||
    !isPromotionState(journal.state) ||
    typeof journal.hadCanonical !== 'boolean' ||
    !journal.stagedMeta ||
    !journal.stagedDb ||
    typeof journal.stagedMeta.lastCommit !== 'string' ||
    typeof journal.stagedMeta.indexedAt !== 'string' ||
    (journal.sourceMetaFiles !== undefined && !validMetaFilesIdentity(journal.sourceMetaFiles)) ||
    (journal.sourceRepo !== undefined && !validRepositoryIdentity(journal.sourceRepo))
  ) {
    throw new Error('Staged-promotion journal is corrupt or from an unsupported version');
  }
  return journal;
};

const updateJournal = async (
  paths: StagedAnalyzePaths,
  journal: PromotionJournal,
  state: PromotionState,
  projectName?: string,
): Promise<PromotionJournal> => {
  const next: PromotionJournal = {
    ...journal,
    state,
    updatedAt: new Date().toISOString(),
    projectName: projectName ?? journal.projectName,
  };
  await writeDurableJson(paths.journalPath, next);
  return next;
};

const moveAndSync = async (source: string, target: string): Promise<void> => {
  await retryRename(source, target);
  await syncDirectory(path.dirname(target));
};

export const getStagedAnalyzePaths = (
  canonicalLbugPath: string,
  canonicalMetaDir: string,
): StagedAnalyzePaths => {
  const stageRoot = `${canonicalLbugPath}.staged-work`;
  return {
    canonicalLbugPath,
    canonicalMetaDir,
    stageRoot,
    stageIntentPath: `${stageRoot}.intent.json`,
    stagedLbugPath: path.join(stageRoot, 'lbug'),
    stagedMetaDir: path.join(stageRoot, 'meta'),
    stageManifestPath: path.join(stageRoot, 'manifest.json'),
    backupLbugPath: `${canonicalLbugPath}.promotion-backup`,
    journalPath: path.join(canonicalMetaDir, 'analyze-promotion.json'),
  };
};

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface AnalyzeOwnershipLockOptions {
  /** Frozen physical repository root shared by analyze, embed, and delete. */
  repoRoot?: string;
  /** DELETE sets this false so locking an absent generation does not create it. */
  createStoragePath?: boolean;
}

const withOwnershipFileLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const record: StageLockRecord = {
    schema: 'gitnexus.staged-analyze-lock/v1',
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readJson<StageLockRecord>(lockPath);
      if (owner?.schema === record.schema && processIsAlive(owner.pid)) {
        throw new Error(
          `Another analyze is active (pid ${owner.pid}, started ${owner.startedAt}).`,
        );
      }
      if (attempt === 1) throw new Error('Could not reclaim the stale analyze lock');
      await fs.rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error('Could not acquire the analyze lock');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJson<StageLockRecord>(lockPath).catch(() => undefined);
    if (current?.nonce === record.nonce) await fs.rm(lockPath, { force: true });
  }
};

const analyzeOwnershipCompanionPath = (repoRoot: string): string => {
  const canonicalRoot = canonicalizePath(repoRoot);
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 32);
  return path.join(path.resolve(getGlobalDir()), 'locks', `analyze-${digest}.lock`);
};

/**
 * Serialize every supported writer; a dead owner's lock is reclaimed on the next run.
 *
 * New writers first hold a transient companion lock in the user-owned global
 * GitNexus lock directory. It survives storage and repository detach/removal
 * without requiring write access to the repository parent. The existing
 * storage lock remains the second boundary so an older writer that acquired it
 * before storage was detached is still excluded. Starting a pre-companion
 * writer after detach is outside this source contract; runtime admission must
 * contain legacy endpoints before a current-version delete can run.
 */
export const withAnalyzeOwnershipLock = async <T>(
  storagePath: string,
  operation: () => Promise<T>,
  options: AnalyzeOwnershipLockOptions = {},
): Promise<T> => {
  // The caller owns storage identity and may already have frozen a physical
  // target before repository disappearance. Resolve syntax only; never
  // realpath/recompute that identity here.
  const lockedStoragePath = path.resolve(storagePath);
  const withStorageLock = async (): Promise<T> => {
    if (options.createStoragePath === false) {
      try {
        await fs.access(lockedStoragePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return operation();
        throw error;
      }
    } else {
      await fs.mkdir(lockedStoragePath, { recursive: true });
    }

    // Keep the existing filename so an older staged writer and a newer ordinary
    // writer still contend during an in-place upgrade.
    return withOwnershipFileLock(path.join(lockedStoragePath, 'analyze-staged.lock'), operation);
  };

  if (!options.repoRoot) return withStorageLock();
  const companionPath = analyzeOwnershipCompanionPath(options.repoRoot);
  await fs.mkdir(path.dirname(companionPath), { recursive: true, mode: 0o700 });
  return withOwnershipFileLock(companionPath, withStorageLock);
};

/** @deprecated Use the common ownership lock so plain and staged writers cannot overlap. */
export const withStagedAnalyzeLock = withAnalyzeOwnershipLock;

/**
 * Read-only preflight used by callers that must preserve a prior staged
 * artifact instead of letting preparation replace source-mismatched derived
 * state. A legacy manifest without complete source identity never matches.
 */
export const inspectStagedWorkspaceSource = async (
  paths: StagedAnalyzePaths,
  canonicalMeta: RepoMeta | null,
  sourceRepo: RepositorySourceIdentity,
): Promise<{ exists: boolean; matchesSource: boolean }> => {
  let exists = false;
  try {
    await fs.lstat(paths.stageRoot);
    exists = true;
  } catch (error) {
    if (!isMissingFilesystemError(error)) throw error;
  }
  if (!exists) return { exists: false, matchesSource: false };

  const manifest = await readManifest(paths);
  if (!manifest?.sourceMetaFiles || !manifest.sourceRepo) {
    return { exists: true, matchesSource: false };
  }
  const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
  const sourceMeta = canonicalMeta ? metaIdentity(canonicalMeta) : undefined;
  const sourceMetaFiles = await statMetadataFiles(paths.canonicalMetaDir);
  return {
    exists: true,
    matchesSource:
      identitiesEqual(manifest.sourceMeta, sourceMeta) &&
      identitiesEqual(manifest.sourceMetaFiles, sourceMetaFiles) &&
      identitiesEqual(manifest.sourceDb, canonicalDb) &&
      identitiesEqual(manifest.sourceRepo, sourceRepo),
  };
};

/**
 * Create or resume the isolated build workspace. A stage tree is removed only
 * when a complete canonical generation or a durable stage intent/manifest
 * proves that the tree is disposable derived state.
 */
export const prepareStagedWorkspace = async (
  paths: StagedAnalyzePaths,
  canonicalMeta: RepoMeta | null,
  sourceRepo: RepositorySourceIdentity = { head: '', branch: null },
  hooks: PrepareStagedHooks = {},
): Promise<{ resumed: boolean; generationId: string }> => {
  if (await readJournal(paths)) {
    throw new Error('A staged-promotion journal must be recovered before preparing another build');
  }
  if (await statRegularFile(paths.backupLbugPath)) {
    throw new Error(
      `Unjournaled promotion backup exists at ${paths.backupLbugPath}; refusing to overwrite it.`,
    );
  }

  const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
  if ((canonicalMeta === null) !== (canonicalDb === undefined)) {
    throw new Error(
      'Canonical metadata/database presence disagrees; refusing staged analysis because the live generation cannot be proven complete.',
    );
  }
  if (canonicalDb) await assertNoDbSidecars(paths.canonicalLbugPath, 'Canonical index');

  const sourceMeta = canonicalMeta ? metaIdentity(canonicalMeta) : undefined;
  const sourceMetaFiles = await statMetadataFiles(paths.canonicalMetaDir);
  const manifest = await readManifest(paths);
  const intent = await readIntent(paths);
  const sameSource = (candidate: StageManifest | StageIntent): boolean =>
    identitiesEqual(candidate.sourceMeta, sourceMeta) &&
    identitiesEqual(candidate.sourceMetaFiles, sourceMetaFiles) &&
    identitiesEqual(candidate.sourceDb, canonicalDb) &&
    identitiesEqual(candidate.sourceRepo, sourceRepo);

  if (manifest) {
    if (sameSource(manifest)) {
      await fs.rm(paths.stageIntentPath, { force: true });
      const stagedDb = await statRegularFile(paths.stagedLbugPath);
      const stagedMeta = await loadMeta(paths.stagedMetaDir);
      if (canonicalDb && (!stagedDb || !stagedMeta)) {
        throw new Error(
          'The staged workspace manifest matches the canonical generation, but its DB or metadata is missing.',
        );
      }
      return { resumed: true, generationId: manifest.generationId };
    }
    // A valid manifest proves this is disposable derived state even for a
    // first-generation index where no canonical DB exists yet.
    await fs.rm(paths.stageRoot, { recursive: true, force: true });
    await fs.rm(paths.stageIntentPath, { force: true });
  } else {
    let stageExists = false;
    try {
      await fs.lstat(paths.stageRoot);
      stageExists = true;
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
    if (stageExists) {
      if (!intent && (!canonicalDb || !canonicalMeta)) {
        throw new Error(
          'An unowned incomplete staged workspace exists and no complete canonical generation is available for safe cleanup.',
        );
      }
      // A durable intent proves the incomplete tree belongs to staged analyze;
      // removing it is safe even on the first generation. A complete canonical
      // generation remains the fallback for legacy trees without an intent.
      await fs.rm(paths.stageRoot, { recursive: true, force: true });
    }
    if (intent && !sameSource(intent)) await fs.rm(paths.stageIntentPath, { force: true });
  }

  const durableIntent: StageIntent =
    intent && sameSource(intent)
      ? intent
      : {
          schema: STAGE_INTENT_SCHEMA,
          generationId: randomBytes(16).toString('hex'),
          createdAt: new Date().toISOString(),
          sourceMeta,
          sourceMetaFiles,
          sourceDb: canonicalDb,
          sourceRepo,
        };
  // This sibling intent is durable before stageRoot is created. If the process
  // dies after mkdir/copy but before the manifest, the next run can prove the
  // partial tree is ours and rebuild it automatically.
  await writeDurableJson(paths.stageIntentPath, durableIntent);
  await fs.mkdir(paths.stagedMetaDir, { recursive: true });
  if (canonicalDb && canonicalMeta) {
    const tempDb = `${paths.stagedLbugPath}.copy-${randomBytes(8).toString('hex')}`;
    await fs.copyFile(paths.canonicalLbugPath, tempDb);
    const handle = await fs.open(tempDb, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await moveAndSync(tempDb, paths.stagedLbugPath);
    await saveMeta(paths.stagedMetaDir, canonicalMeta);
  }
  await hooks.afterStagePrepared?.();

  const next: StageManifest = {
    schema: STAGE_MANIFEST_SCHEMA,
    generationId: durableIntent.generationId,
    createdAt: durableIntent.createdAt,
    sourceMeta,
    sourceMetaFiles,
    sourceDb: canonicalDb,
    sourceRepo,
  };
  await writeDurableJson(paths.stageManifestPath, next);
  await fs.rm(paths.stageIntentPath, { force: true });
  await syncDirectory(path.dirname(paths.stageIntentPath));
  return { resumed: false, generationId: next.generationId };
};

export const discardStagedWorkspace = async (paths: StagedAnalyzePaths): Promise<void> => {
  if (await readJournal(paths)) {
    throw new Error('Cannot discard a staged workspace while promotion recovery is pending');
  }
  await fs.rm(paths.stageRoot, { recursive: true, force: true });
  await fs.rm(paths.stageIntentPath, { force: true });
};

/** Validate the staged DB/meta pair before the first canonical rename. */
export const validateStagedGeneration = async (paths: StagedAnalyzePaths): Promise<RepoMeta> => {
  const manifest = await readManifest(paths);
  if (!manifest) throw new Error('Staged generation has no durable manifest');
  const db = await statRegularFile(paths.stagedLbugPath);
  if (!db || db.size === 0) throw new Error('Staged generation has no non-empty LadybugDB file');
  await assertNoDbSidecars(paths.stagedLbugPath, 'Staged index');
  const meta = await loadMeta(paths.stagedMetaDir);
  if (!meta) throw new Error('Staged generation has no readable metadata');
  if (meta.incrementalInProgress || meta.embeddingCheckpoint) {
    throw new Error('Staged generation still carries an incomplete write/checkpoint marker');
  }
  return meta;
};

interface CapturedPromotionSource {
  sourceMeta?: MetaIdentity;
  sourceMetaFiles: MetaFilesIdentity;
  sourceDb?: FileIdentity;
  sourceRepo: RepositorySourceIdentity;
  hadCanonical: boolean;
  stagedDb?: FileIdentity;
}

class PromotionSourceChangedError extends Error {
  constructor(
    readonly kind: 'metadata' | 'database' | 'repository',
    message: string,
    readonly metadataState?: 'source' | 'staged',
  ) {
    super(message);
    this.name = 'PromotionSourceChangedError';
  }
}

const assertPromotionSourceUnchanged = async (
  paths: StagedAnalyzePaths,
  source: CapturedPromotionSource,
  hooks: PromotionHooks,
  allowOldDbInBackup: boolean,
  allowedStagedMeta?: RepoMeta,
): Promise<'source' | 'staged'> => {
  const canonicalMeta = await loadMeta(paths.canonicalMetaDir);
  const currentMeta = canonicalMeta ? metaIdentity(canonicalMeta) : undefined;
  const metadataState =
    allowedStagedMeta && identitiesEqual(canonicalMeta, allowedStagedMeta)
      ? 'staged'
      : identitiesEqual(currentMeta, source.sourceMeta)
        ? 'source'
        : undefined;
  if (!metadataState) {
    throw new PromotionSourceChangedError(
      'metadata',
      'Staged promotion refused: canonical metadata changed after the stage source was captured.',
    );
  }
  if (metadataState === 'source') {
    const currentMetaFiles = await statMetadataFiles(paths.canonicalMetaDir);
    if (!identitiesEqual(currentMetaFiles, source.sourceMetaFiles)) {
      throw new PromotionSourceChangedError(
        'metadata',
        'Staged promotion refused: canonical metadata file identity changed after the stage source was captured.',
      );
    }
  }

  const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
  const backupDb = allowOldDbInBackup ? await statRegularFile(paths.backupLbugPath) : undefined;
  const dbMatches =
    metadataState === 'staged'
      ? identitiesEqual(canonicalDb, source.stagedDb)
      : source.hadCanonical
        ? identitiesEqual(canonicalDb, source.sourceDb) ||
          identitiesEqual(backupDb, source.sourceDb)
        : source.sourceDb === undefined &&
          (canonicalDb === undefined ||
            (allowOldDbInBackup && identitiesEqual(canonicalDb, source.stagedDb)));
  if (!dbMatches) {
    throw new PromotionSourceChangedError(
      'database',
      'Staged promotion refused: canonical database identity changed after the stage source was captured.',
    );
  }

  // Once the exact staged DB/meta pair is canonical, source HEAD movement no
  // longer invalidates that installed generation. Registration is the only
  // unfinished idempotent step and must be allowed to complete.
  if (hooks.readRepositoryIdentity && metadataState === 'source') {
    const currentRepo = await hooks.readRepositoryIdentity();
    if (!identitiesEqual(currentRepo, source.sourceRepo)) {
      throw new PromotionSourceChangedError(
        'repository',
        'Staged promotion refused: repository HEAD or branch changed while the staged generation was building.',
        metadataState,
      );
    }
  }
  return metadataState;
};

const rollbackPromotionForRepositoryChange = async (
  paths: StagedAnalyzePaths,
  journal: PromotionJournal,
): Promise<void> => {
  let canonical = await statRegularFile(paths.canonicalLbugPath);
  const staged = await statRegularFile(paths.stagedLbugPath);
  const backup = await statRegularFile(paths.backupLbugPath);

  if (canonical && identitiesEqual(canonical, journal.stagedDb)) {
    if (staged) {
      throw new Error('Cannot roll back stale promotion because both new DB copies exist');
    }
    await moveAndSync(paths.canonicalLbugPath, paths.stagedLbugPath);
    canonical = undefined;
  }

  if (journal.hadCanonical) {
    if (canonical && identitiesEqual(canonical, journal.oldDb)) {
      if (backup) {
        throw new Error('Cannot roll back stale promotion because the old DB exists twice');
      }
    } else if (!canonical && backup && identitiesEqual(backup, journal.oldDb)) {
      await moveAndSync(paths.backupLbugPath, paths.canonicalLbugPath);
    } else {
      throw new Error(
        'Cannot roll back stale promotion because the canonical backup identity is ambiguous',
      );
    }
  } else if (canonical) {
    throw new Error(
      'Cannot roll back stale first-generation promotion with an unknown canonical DB',
    );
  }

  await fs.rm(paths.backupLbugPath, { force: true });
  await fs.rm(paths.stageRoot, { recursive: true, force: true });
  await fs.rm(paths.stageIntentPath, { force: true });
  await fs.rm(paths.journalPath, { force: true });
  await syncDirectory(paths.canonicalMetaDir);
};

/**
 * Resume or execute the four-state promotion. Every destructive rename has a
 * complete generation on the other side, and the old DB is retained until
 * metadata plus registry commit succeeds.
 */
export const promoteStagedGeneration = async (
  paths: StagedAnalyzePaths,
  commitMetadataAndRegistry: (meta: RepoMeta) => Promise<string>,
  hooks: PromotionHooks = {},
): Promise<PromotionResult> => {
  let journal = await readJournal(paths);
  const recovered = journal !== undefined;
  if (!journal) {
    const meta = await validateStagedGeneration(paths);
    const manifest = await readManifest(paths);
    if (!manifest) throw new Error('Staged generation manifest disappeared during validation');
    if (!manifest.sourceMetaFiles || !manifest.sourceRepo) {
      throw new Error(
        'Legacy staged generation lacks source identity; rerun staged analyze to rebuild it safely.',
      );
    }
    const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
    if (await statRegularFile(paths.backupLbugPath)) {
      throw new Error('Cannot begin promotion while an unjournaled backup generation exists');
    }
    if (canonicalDb) await assertNoDbSidecars(paths.canonicalLbugPath, 'Canonical index');
    await assertPromotionSourceUnchanged(
      paths,
      {
        sourceMeta: manifest.sourceMeta,
        sourceMetaFiles: manifest.sourceMetaFiles,
        sourceDb: manifest.sourceDb,
        sourceRepo: manifest.sourceRepo,
        hadCanonical: manifest.sourceDb !== undefined,
      },
      hooks,
      false,
    );
    journal = {
      schema: PROMOTION_JOURNAL_SCHEMA,
      generationId: manifest.generationId,
      state: 'prepared',
      updatedAt: new Date().toISOString(),
      hadCanonical: canonicalDb !== undefined,
      stagedMeta: metaIdentity(meta),
      stagedDb: (await statRegularFile(paths.stagedLbugPath))!,
      oldDb: canonicalDb,
      sourceMeta: manifest.sourceMeta,
      sourceMetaFiles: manifest.sourceMetaFiles,
      sourceDb: manifest.sourceDb,
      sourceRepo: manifest.sourceRepo,
    };
    await writeDurableJson(paths.journalPath, journal);
    await hooks.afterBoundary?.('prepared');
  }

  const ensureJournalSourceCurrent = async (): Promise<void> => {
    if (journal.state === 'metadata/registry-committed') return;
    // Journals written by the previous exact head did not capture these two
    // guards. Preserve their artifact-identity recovery semantics; every new
    // journal records and enforces the stronger source identity below.
    if (!journal.sourceMetaFiles || !journal.sourceRepo) return;
    let allowedStagedMeta: RepoMeta | undefined;
    if (journal.state === 'new-installed') {
      allowedStagedMeta = await loadMeta(paths.stagedMetaDir);
      if (
        !allowedStagedMeta ||
        !identitiesEqual(metaIdentity(allowedStagedMeta), journal.stagedMeta)
      ) {
        throw new Error('Staged metadata identity changed after promotion was prepared');
      }
    }
    try {
      await assertPromotionSourceUnchanged(
        paths,
        {
          sourceMeta: journal.sourceMeta,
          sourceMetaFiles: journal.sourceMetaFiles,
          sourceDb: journal.sourceDb,
          sourceRepo: journal.sourceRepo,
          hadCanonical: journal.hadCanonical,
          stagedDb: journal.stagedDb,
        },
        hooks,
        true,
        allowedStagedMeta,
      );
    } catch (error) {
      if (
        error instanceof PromotionSourceChangedError &&
        error.kind === 'repository' &&
        error.metadataState !== 'staged'
      ) {
        await rollbackPromotionForRepositoryChange(paths, journal);
      }
      throw error;
    }
  };

  await ensureJournalSourceCurrent();

  if (journal.state === 'prepared') {
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    const backup = await statRegularFile(paths.backupLbugPath);
    if (journal.hadCanonical) {
      if (
        canonical &&
        staged &&
        !backup &&
        identitiesEqual(canonical, journal.oldDb) &&
        identitiesEqual(staged, journal.stagedDb)
      ) {
        await moveAndSync(paths.canonicalLbugPath, paths.backupLbugPath);
      } else if (
        !canonical &&
        staged &&
        backup &&
        identitiesEqual(staged, journal.stagedDb) &&
        identitiesEqual(backup, journal.oldDb)
      ) {
        // Crash after the rename but before the journal transition.
      } else if (
        canonical &&
        !staged &&
        backup &&
        identitiesEqual(canonical, journal.stagedDb) &&
        identitiesEqual(backup, journal.oldDb)
      ) {
        journal = await updateJournal(paths, journal, 'new-installed');
      } else {
        throw new Error('Ambiguous prepared promotion artifacts; refusing to choose a generation');
      }
    } else if (!canonical && staged && !backup && identitiesEqual(staged, journal.stagedDb)) {
      // First index: there is no old generation to back up.
    } else if (canonical && !staged && !backup && identitiesEqual(canonical, journal.stagedDb)) {
      journal = await updateJournal(paths, journal, 'new-installed');
    } else {
      throw new Error('Ambiguous first-generation promotion artifacts');
    }
    if (journal.state === 'prepared') {
      journal = await updateJournal(paths, journal, 'old-backed-up');
      await hooks.afterBoundary?.('old-backed-up');
    }
  }

  if (journal.state === 'old-backed-up') {
    await ensureJournalSourceCurrent();
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    const backup = await statRegularFile(paths.backupLbugPath);
    if (
      !canonical &&
      staged &&
      identitiesEqual(staged, journal.stagedDb) &&
      (!journal.hadCanonical || identitiesEqual(backup, journal.oldDb))
    ) {
      await moveAndSync(paths.stagedLbugPath, paths.canonicalLbugPath);
    } else if (canonical && !staged && identitiesEqual(canonical, journal.stagedDb)) {
      // Crash after install but before the journal transition.
    } else if (
      !canonical &&
      !staged &&
      backup &&
      journal.hadCanonical &&
      identitiesEqual(backup, journal.oldDb)
    ) {
      await moveAndSync(paths.backupLbugPath, paths.canonicalLbugPath);
      throw new Error('Staged generation is missing; restored the canonical backup instead');
    } else {
      throw new Error(
        'Ambiguous old-backed-up promotion artifacts; refusing to delete or overwrite',
      );
    }
    journal = await updateJournal(paths, journal, 'new-installed');
    await hooks.afterBoundary?.('new-installed');
  }

  if (journal.state === 'new-installed') {
    await ensureJournalSourceCurrent();
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    if (!canonical || !identitiesEqual(canonical, journal.stagedDb)) {
      const backup = await statRegularFile(paths.backupLbugPath);
      if (backup && journal.hadCanonical && identitiesEqual(backup, journal.oldDb)) {
        await moveAndSync(paths.backupLbugPath, paths.canonicalLbugPath);
      }
      throw new Error(
        'Installed generation is missing or has the wrong identity; restored the backup when available',
      );
    }
    if (staged) throw new Error('Both staged and installed DB files exist after promotion');
    const stagedMeta = await loadMeta(paths.stagedMetaDir);
    if (!stagedMeta || !identitiesEqual(metaIdentity(stagedMeta), journal.stagedMeta)) {
      throw new Error('Staged metadata identity changed after promotion was prepared');
    }
    const projectName = await commitMetadataAndRegistry(stagedMeta);
    journal = await updateJournal(paths, journal, 'metadata/registry-committed', projectName);
    await hooks.afterBoundary?.('metadata/registry-committed');
  }

  if (journal.state !== 'metadata/registry-committed') {
    throw new Error(`Unsupported promotion state: ${journal.state}`);
  }
  const committedCanonical = await statRegularFile(paths.canonicalLbugPath);
  if (!committedCanonical || !identitiesEqual(committedCanonical, journal.stagedDb)) {
    throw new Error(
      'Cannot clean promotion artifacts because the canonical DB is missing or has the wrong identity',
    );
  }
  await fs.rm(paths.backupLbugPath, { force: true });
  await fs.rm(paths.stageRoot, { recursive: true, force: true });
  await fs.rm(paths.stageIntentPath, { force: true });
  await fs.rm(paths.journalPath, { force: true });
  await syncDirectory(paths.canonicalMetaDir);
  return { projectName: journal.projectName, recovered };
};

export const hasPendingPromotion = async (paths: StagedAnalyzePaths): Promise<boolean> =>
  (await readJournal(paths)) !== undefined;
