import fs from 'node:fs';
import path from 'node:path';
import type { LocalBackend, RepoListing } from './local/local-backend.js';
import { parseListReposPagination } from './local/local-backend.js';
import { LIST_REPOS_DEFAULT_LIMIT, LIST_REPOS_MAX_LIMIT } from './tools.js';
import type { GITNEXUS_TOOLS } from './tools.js';

type GitNexusTool = (typeof GITNEXUS_TOOLS)[number];

const CANONICAL_ALLOWED = 'GITNEXUS_MCP_ALLOWED_REPOS';
const CANONICAL_DEFAULT = 'GITNEXUS_MCP_DEFAULT_REPO';
const OPENCLAW_ALLOWED = 'OPENCLAW_CODE_INDEX_ALLOWED_REPOS';
const OPENCLAW_DEFAULT = 'OPENCLAW_CODE_INDEX_DEFAULT_REPO';

interface RawRepositoryPolicy {
  allowed?: Array<{ value: string; entryPosition: number }>;
  allowedKey?: string;
  defaultRepo?: string;
  defaultKey?: string;
}

interface ResolvedRepository {
  name: string;
  path: string;
  pathKey: string;
  filesystemIdentity?: string;
}

export interface McpRepositoryPolicyRejection {
  environmentKey: string;
  entryPosition: number;
  failureClass: 'invalid' | 'ambiguous';
}

/** Minimal read-only surface needed by the production policy resolver. */
export interface RepositoryPolicyRegistryBackend {
  listRepos(): Promise<RepoListing[]>;
}

export type McpRepositoryPolicyFailureReason =
  | 'invalid'
  | 'ambiguous'
  | 'blank'
  | 'default_outside_allowlist';

export class McpRepositoryPolicyConfigurationError extends Error {
  readonly key: string;
  readonly reason: McpRepositoryPolicyFailureReason;
  readonly entryPosition?: number;

  constructor(key: string, reason: McpRepositoryPolicyFailureReason, entryPosition?: number) {
    const location = entryPosition === undefined ? key : `${key} entry ${entryPosition}`;
    const message =
      reason === 'ambiguous'
        ? `MCP repository policy is blocked: MCP repository configuration contains an ambiguous repository selection at ${location}. Use an absolute indexed repository path when names are duplicated, then restart GitNexus MCP.`
        : reason === 'invalid'
          ? `MCP repository policy is blocked: MCP repository configuration contains an invalid repository selection at ${location}. Update or remove the entry, then restart GitNexus MCP.`
          : reason === 'blank'
            ? `MCP repository policy is blocked: ${location} must not be blank. Set a repository name or absolute path, or unset the variable, then restart GitNexus MCP.`
            : `MCP repository policy is blocked: ${location} default repository is not in the configured allowlist. Update the default or allowlist, then restart GitNexus MCP.`;
    super(message);
    this.name = 'McpRepositoryPolicyConfigurationError';
    this.key = key;
    this.reason = reason;
    this.entryPosition = entryPosition;
  }
}

function configuredValue(
  env: NodeJS.ProcessEnv,
  canonical: string,
  compatibilityAlias: string,
): { key: string; value: string } | undefined {
  const canonicalValue = env[canonical];
  if (canonicalValue !== undefined) return { key: canonical, value: canonicalValue };
  const compatibilityValue = env[compatibilityAlias];
  if (compatibilityValue !== undefined)
    return { key: compatibilityAlias, value: compatibilityValue };
  return undefined;
}

function parseRepositoryPolicy(env: NodeJS.ProcessEnv): RawRepositoryPolicy {
  const allowedRaw = configuredValue(env, CANONICAL_ALLOWED, OPENCLAW_ALLOWED);
  const defaultRaw = configuredValue(env, CANONICAL_DEFAULT, OPENCLAW_DEFAULT);

  let allowed: RawRepositoryPolicy['allowed'];
  if (allowedRaw) {
    allowed = allowedRaw.value
      .split(',')
      .map((entry, index) => ({ value: entry.trim(), entryPosition: index + 1 }));
  }

  let defaultRepo: string | undefined;
  if (defaultRaw) {
    defaultRepo = defaultRaw.value.trim();
    if (!defaultRepo) {
      throw new McpRepositoryPolicyConfigurationError(defaultRaw.key, 'blank', 1);
    }
  }

  return {
    allowed,
    allowedKey: allowedRaw?.key,
    defaultRepo,
    defaultKey: defaultRaw?.key,
  };
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function existingFilesystemIdentity(value: string): string | undefined {
  try {
    const resolved = fs.realpathSync.native(path.resolve(value));
    const stats = fs.statSync(resolved, { bigint: true });
    if (stats.ino !== 0n) return `${stats.dev}:${stats.ino}`;
    return `path:${normalizedPath(resolved)}`;
  } catch {
    return undefined;
  }
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function resolveSpecifier(
  specifier: string,
  registry: readonly ResolvedRepository[],
): { repo?: ResolvedRepository; reason?: 'invalid' | 'ambiguous' } {
  const trimmed = specifier.trim();
  let matches: readonly ResolvedRepository[];
  if (isAbsolutePath(trimmed)) {
    matches = registry.filter((repo) => repo.pathKey === normalizedPath(trimmed));
    if (matches.length === 0) {
      const identity = existingFilesystemIdentity(trimmed);
      if (identity) {
        matches = registry.filter((repo) => repo.filesystemIdentity === identity);
      }
    }
  } else {
    matches = registry.filter((repo) => repo.name.toLowerCase() === trimmed.toLowerCase());
  }

  if (matches.length === 0) return { reason: 'invalid' };
  if (matches.length > 1) return { reason: 'ambiguous' };
  return { repo: matches[0] };
}

function unavailableRepositoryError(): Error {
  return new Error('Repository is not available through this MCP server.');
}

export class McpRepositoryPolicy {
  readonly restricted: boolean;
  readonly configured: boolean;
  readonly configurationError?: McpRepositoryPolicyConfigurationError;
  readonly rejectedEntries: readonly McpRepositoryPolicyRejection[];

  private readonly registry: readonly ResolvedRepository[];
  private readonly allowed: readonly ResolvedRepository[];
  private readonly allowedPathKeys: ReadonlySet<string>;
  private readonly defaultRepo?: ResolvedRepository;
  private readonly uniqueAllowedContextNames: ReadonlySet<string>;

  static unrestricted(): McpRepositoryPolicy {
    return new McpRepositoryPolicy([], undefined, undefined);
  }

  static blocked(error: McpRepositoryPolicyConfigurationError): McpRepositoryPolicy {
    return new McpRepositoryPolicy([], [], undefined, error);
  }

  constructor(
    registry: readonly ResolvedRepository[],
    allowed: readonly ResolvedRepository[] | undefined,
    defaultRepo: ResolvedRepository | undefined,
    configurationError?: McpRepositoryPolicyConfigurationError,
    rejectedEntries: readonly McpRepositoryPolicyRejection[] = [],
  ) {
    this.registry = registry;
    this.restricted = allowed !== undefined;
    this.configured = this.restricted || defaultRepo !== undefined;
    this.allowed = allowed ?? registry;
    this.allowedPathKeys = new Set(this.allowed.map((repo) => repo.pathKey));
    this.defaultRepo = defaultRepo;
    this.configurationError = configurationError;
    this.rejectedEntries = rejectedEntries;

    const registryNameCounts = new Map<string, number>();
    for (const repo of registry) {
      const name = repo.name.toLowerCase();
      registryNameCounts.set(name, (registryNameCounts.get(name) ?? 0) + 1);
    }
    this.uniqueAllowedContextNames = new Set(
      this.allowed
        .map((repo) => repo.name.toLowerCase())
        .filter((name) => registryNameCounts.get(name) === 1),
    );
  }

  private resolveRuntimeRepo(specifier: string): ResolvedRepository {
    const result = resolveSpecifier(specifier, this.registry);
    if (!result.repo || (this.restricted && !this.allowedPathKeys.has(result.repo.pathKey))) {
      throw unavailableRepositoryError();
    }
    return result.repo;
  }

  private repoForArgs(args: Record<string, unknown> | undefined): ResolvedRepository | undefined {
    const explicit = args?.repo;
    if (explicit !== undefined) {
      if (typeof explicit !== 'string') throw unavailableRepositoryError();
      if (explicit.trim().startsWith('@')) {
        if (this.restricted) {
          throw new Error('Group routing is unavailable when an MCP repository allowlist is set.');
        }
        return undefined;
      }
      return this.resolveRuntimeRepo(explicit);
    }

    if (this.defaultRepo) return this.defaultRepo;
    if (this.restricted && this.allowed.length === 1) return this.allowed[0];
    if (this.restricted && this.allowed.length > 1) {
      throw new Error('Specify an explicit repo because multiple repositories are allowed.');
    }
    return undefined;
  }

  private normalizeToolArgs(
    args: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!this.configured) return args;
    if (!this.restricted && args?.repo !== undefined) return args;
    const selected = this.repoForArgs(args);
    if (!selected) return args;
    return { ...(args ?? {}), repo: selected.path };
  }

  private async listAllowedRepos(backend: LocalBackend): Promise<RepoListing[]> {
    if (this.configurationError) throw this.configurationError;
    const current = await backend.listRepos();
    if (!this.restricted) return current;
    return current
      .filter((repo) => this.allowedPathKeys.has(normalizedPath(repo.path)))
      .map((repo) => {
        const siblings = repo.siblings?.filter((sibling) =>
          this.allowedPathKeys.has(normalizedPath(sibling.path)),
        );
        return {
          ...repo,
          siblings: siblings && siblings.length > 0 ? siblings : undefined,
        };
      });
  }

  private async listReposPage(
    backend: LocalBackend,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const { limit, offset } = parseListReposPagination(params, {
      defaultLimit: LIST_REPOS_DEFAULT_LIMIT,
      maxLimit: LIST_REPOS_MAX_LIMIT,
    });
    const repositories = await this.listAllowedRepos(backend);
    repositories.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    const total = repositories.length;
    const page = repositories.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < total;
    return {
      repositories: page,
      pagination: {
        total,
        limit,
        offset,
        returned,
        hasMore,
        ...(hasMore && { nextOffset: offset + returned }),
      },
      ...(this.rejectedEntries.length > 0 && {
        repositoryPolicy: {
          status: 'degraded',
          rejectedEntries: this.rejectedEntries,
        },
      }),
    };
  }

  private async callTool(
    backend: LocalBackend,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (this.configurationError) throw this.configurationError;
    if (!this.configured) return backend.callTool(method, params);
    if (method === 'list_repos') return this.listReposPage(backend, params);
    if (this.restricted && method.startsWith('group_')) {
      throw new Error('Group tools are unavailable when an MCP repository allowlist is set.');
    }
    return backend.callTool(method, this.normalizeToolArgs(params));
  }

  private async resolveRepo(
    backend: LocalBackend,
    repo?: string,
    branch?: string,
  ): Promise<Awaited<ReturnType<LocalBackend['resolveRepo']>>> {
    if (this.configurationError) throw this.configurationError;
    if (!this.configured) return backend.resolveRepo(repo, branch);
    if (!this.restricted) return backend.resolveRepo(repo ?? this.defaultRepo?.path, branch);
    const selected = this.repoForArgs(repo === undefined ? undefined : { repo });
    return backend.resolveRepo(selected?.path, branch);
  }

  assertResourceUri(uri: string): void {
    if (this.configurationError) throw this.configurationError;
    if (!this.restricted) return;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return;
    }
    if (parsed.protocol !== 'gitnexus:') return;
    if (parsed.hostname === 'group') {
      throw new Error('Group resources are unavailable when an MCP repository allowlist is set.');
    }
    if (parsed.hostname !== 'repo') return;
    const repoName = parsed.pathname.split('/').filter(Boolean)[0];
    if (!repoName) return;
    this.resolveRuntimeRepo(decodeURIComponent(repoName));
  }

  resourceTemplateAllowed(uriTemplate: string): boolean {
    return !this.restricted || !uriTemplate.startsWith('gitnexus://group/');
  }

  toolAllowed(toolName: string): boolean {
    return !this.restricted || !toolName.startsWith('group_');
  }

  toolForMcp(tool: GitNexusTool): GitNexusTool {
    if (!this.restricted) return tool;
    const properties = { ...tool.inputSchema.properties };
    const repo = properties.repo;
    if (repo && typeof repo === 'object') {
      properties.repo = {
        ...repo,
        description: 'Allowed indexed repository name or path. Group-mode values are unavailable.',
      };
    }
    delete properties.subgroup;
    delete properties.crossDepth;
    const description = tool.description
      .replace(/\nGROUP MODE:[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
      .replace(/\nCROSS-REPO \(experimental\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
      .replace(/\nDESTINATION TRACE \(cross-repo\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '');
    const degradedNotice =
      this.rejectedEntries.length > 0
        ? `DEGRADED: MCP repository policy rejected ${this.rejectedEntries.length} configured allowlist ${this.rejectedEntries.length === 1 ? 'entry' : 'entries'}; valid entries remain available and rejected entries grant no access. Run \`gitnexus doctor --mcp-config --json\` for sanitized coordinates.\n\n`
        : '';
    return {
      ...tool,
      description: this.configurationError
        ? `BLOCKED: ${this.configurationError.message}\n\n${description}`
        : `${degradedNotice}${description}`,
      inputSchema: { ...tool.inputSchema, properties },
    };
  }

  scopeBackend(backend: LocalBackend): LocalBackend {
    const policy = this;
    return new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (policy.configurationError && typeof value === 'function') {
          return () => {
            throw policy.configurationError;
          };
        }
        if (property === 'callTool') {
          return (method: string, params: Record<string, unknown> | undefined) =>
            policy.callTool(target, method, params);
        }
        if (property === 'listRepos') return () => policy.listAllowedRepos(target);
        if (property === 'resolveRepo') {
          return (repo?: string, branch?: string) => policy.resolveRepo(target, repo, branch);
        }
        if (property === 'getContext' && policy.restricted) {
          return (repoId?: string) => {
            if (!repoId || !policy.uniqueAllowedContextNames.has(repoId.toLowerCase())) return null;
            return target.getContext(repoId);
          };
        }
        if (
          policy.restricted &&
          (property === 'readGroupContractsResource' || property === 'readGroupStatusResource')
        ) {
          return async () => {
            throw new Error(
              'Group resources are unavailable when an MCP repository allowlist is set.',
            );
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

export function mcpRepositoryPolicyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = parseRepositoryPolicy(env);
  return raw.allowed !== undefined || raw.defaultRepo !== undefined;
}

export async function createMcpRepositoryPolicy(
  backend: RepositoryPolicyRegistryBackend,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpRepositoryPolicy> {
  const raw = parseRepositoryPolicy(env);
  if (!raw.allowed && !raw.defaultRepo) {
    return McpRepositoryPolicy.unrestricted();
  }

  const registry = (await backend.listRepos()).map((repo) => ({
    name: repo.name,
    path: repo.path,
    pathKey: normalizedPath(repo.path),
    filesystemIdentity: existingFilesystemIdentity(repo.path),
  }));

  let allowed: ResolvedRepository[] | undefined;
  const rejectedEntries: McpRepositoryPolicyRejection[] = [];
  if (raw.allowed) {
    const byPath = new Map<string, ResolvedRepository>();
    for (const specifier of raw.allowed) {
      const result = resolveSpecifier(specifier.value, registry);
      if (!result.repo) {
        rejectedEntries.push({
          environmentKey: raw.allowedKey ?? CANONICAL_ALLOWED,
          entryPosition: specifier.entryPosition,
          failureClass: result.reason === 'ambiguous' ? 'ambiguous' : 'invalid',
        });
        continue;
      }
      byPath.set(result.repo.pathKey, result.repo);
    }
    allowed = [...byPath.values()];
    if (allowed.length === 0) {
      const first = rejectedEntries[0];
      const firstConfiguredEntry = raw.allowed.find(
        (entry) => entry.entryPosition === first?.entryPosition,
      );
      throw new McpRepositoryPolicyConfigurationError(
        first?.environmentKey ?? raw.allowedKey ?? CANONICAL_ALLOWED,
        firstConfiguredEntry?.value ? (first?.failureClass ?? 'invalid') : 'blank',
        first?.entryPosition ?? 1,
      );
    }
  }

  let defaultRepo: ResolvedRepository | undefined;
  if (raw.defaultRepo) {
    const result = resolveSpecifier(raw.defaultRepo, registry);
    if (!result.repo) {
      throw new McpRepositoryPolicyConfigurationError(
        raw.defaultKey ?? CANONICAL_DEFAULT,
        result.reason ?? 'invalid',
        1,
      );
    }
    defaultRepo = result.repo;
  }

  const defaultPathKey = defaultRepo?.pathKey;
  if (defaultPathKey && allowed && !allowed.some((repo) => repo.pathKey === defaultPathKey)) {
    throw new McpRepositoryPolicyConfigurationError(
      raw.defaultKey ?? CANONICAL_DEFAULT,
      'default_outside_allowlist',
      1,
    );
  }

  return new McpRepositoryPolicy(registry, allowed, defaultRepo, undefined, rejectedEntries);
}

export type McpRepositoryPolicyPreflightFailureClass =
  | 'invalid'
  | 'ambiguous'
  | 'default-outside-allowlist';

export type McpRepositoryPolicyPreflightResult =
  | {
      valid: true;
      degraded?: false;
    }
  | {
      valid: true;
      degraded: true;
      rejectedEntries: readonly McpRepositoryPolicyRejection[];
    }
  | {
      valid: false;
      environmentKey: string;
      entryPosition: number;
      failureClass: McpRepositoryPolicyPreflightFailureClass;
    };

/**
 * Validate MCP repository policy with the exact production parser/resolver,
 * without constructing or binding an MCP server. The failure result contains
 * only stable operator coordinates; configured values and registry candidates
 * are deliberately excluded.
 */
export async function preflightMcpRepositoryPolicy(
  backend: RepositoryPolicyRegistryBackend,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpRepositoryPolicyPreflightResult> {
  try {
    const policy = await createMcpRepositoryPolicy(backend, env);
    if (policy.rejectedEntries.length > 0) {
      return {
        valid: true,
        degraded: true,
        rejectedEntries: policy.rejectedEntries,
      };
    }
    return { valid: true };
  } catch (error) {
    if (!(error instanceof McpRepositoryPolicyConfigurationError)) throw error;
    const failureClass: McpRepositoryPolicyPreflightFailureClass =
      error.reason === 'ambiguous'
        ? 'ambiguous'
        : error.reason === 'default_outside_allowlist'
          ? 'default-outside-allowlist'
          : 'invalid';
    return {
      valid: false,
      environmentKey: error.key,
      entryPosition: error.entryPosition ?? 1,
      failureClass,
    };
  }
}
