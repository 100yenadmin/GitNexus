import path from 'node:path';
import { getRuntimeCapabilities, getRuntimeFingerprint } from '../core/platform/capabilities.js';
import { buildRecoveryPlan, formatRecoveryPlan } from '../core/incremental/recovery-plan.js';
import { resolveEmbeddingConfig } from '../core/embeddings/config.js';
import { isHttpMode } from '../core/embeddings/http-client.js';
import {
  getLocalEmbeddingRuntimeBlocker,
  localEmbeddingPrefixUnloadableMessage,
  localEmbeddingStackMissingMessage,
} from '../core/embeddings/runtime-support.js';
import {
  isPrefixRuntimeLoadable,
  resolveEmbeddingRuntime,
  type EmbeddingRuntimeResolution,
} from '../core/embeddings/runtime-install.js';
import { cudaRedirectDoctorStatus } from '../core/embeddings/onnxruntime-node-resolver.js';
import {
  checkLbugNative,
  probeFtsExtensionLoad,
  probeVectorExtensionLoad,
} from '../core/lbug/native-check.js';
import { getOsPageSize, isPageSizeAwareLadybug } from '../core/lbug/lbug-config.js';
import { diagnoseExtensionLoad } from '../core/lbug/extension-load-error.js';
import { getExtensionInstallPolicy } from '../core/lbug/extension-loader.js';
import { getGitRoot } from '../storage/git.js';
import { getStoragePaths, loadMeta, type RepoMeta } from '../storage/repo-manager.js';
import { probeDoctorPool, type DoctorPoolProbe } from './doctor-pool-probe.js';
import { t } from './i18n/index.js';

export { probeDoctorPool, type DoctorPoolProbe } from './doctor-pool-probe.js';

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint === 0) continue;
    if (isCombiningMark(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function padDisplayEnd(value: string, columns: number): string {
  return value + ' '.repeat(Math.max(0, columns - displayWidth(value)));
}

const label = (key: Parameters<typeof t>[0], width: number): string => padDisplayEnd(t(key), width);

/**
 * Embedding-runtime support status for the `doctor` Embeddings section.
 * Pure and DI-friendly so it can be unit-tested without running the whole
 * command. Delegates the platform decision to
 * {@link getLocalEmbeddingRuntimeBlocker} so the wording stays in one place.
 *
 * - HTTP mode: always supported (never touches the native runtime).
 * - Local mode on an unsupported platform (macOS Intel, #1515): reports the
 *   blocker as `detail` so the caller can surface the full guidance.
 */
export function localEmbeddingDoctorStatus(opts: {
  httpMode: boolean;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** Injectable for tests; defaults to probing the real install. */
  resolution?: EmbeddingRuntimeResolution | null;
  /** Injectable for tests; defaults to this Node's registerHooks capability. */
  prefixLoadable?: boolean;
}): { status: string; detail: string | null } {
  if (opts.httpMode) {
    return { status: '✓ http endpoint configured', detail: null };
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const blocker = getLocalEmbeddingRuntimeBlocker({ platform, arch });
  if (blocker) {
    return { status: `✗ local embeddings unavailable on ${platform}/${arch}`, detail: blocker };
  }
  // The stack is an optionalDependency — npm prunes it when onnxruntime-node's
  // postinstall can't download its CUDA binaries (proxy/firewall, #2370).
  const resolution = opts.resolution !== undefined ? opts.resolution : resolveEmbeddingRuntime();
  if (resolution === null) {
    return {
      status: '✗ optional embedding stack not installed',
      detail: localEmbeddingStackMissingMessage(),
    };
  }
  // A prefix-sourced stack needs module.registerHooks to load; on Node < 22.15 /
  // < 23.5 it is present but unreachable (#2372). Report loadability, not bare
  // presence, so the diagnostic stops claiming a ✓ the loader can't honour.
  const prefixLoadable = opts.prefixLoadable ?? isPrefixRuntimeLoadable();
  if (resolution.source === 'runtime-prefix' && !prefixLoadable) {
    return {
      status: '✗ embedding stack installed in the prefix but not loadable on this Node',
      detail: localEmbeddingPrefixUnloadableMessage(),
    };
  }
  return { status: '✓ local embeddings supported', detail: null };
}

/**
 * Page-size lines for the `doctor` Runtime section (#1231). Pure so the
 * warning gate can be unit-tested without running the whole command (the
 * `localEmbeddingDoctorStatus` precedent above) — but takes the probed
 * values as plain params rather than injectable probes, because `undefined`
 * is a *meaningful* pageSize state here (probe unavailable / win32) and
 * would collide with a "not provided → use default" DI convention.
 *
 * Returns 0 lines (page size unknown), 1 line (page size), or 2 lines
 * (page size + non-4K warning when the installed @ladybugdb/core does not
 * detect the OS page size at runtime).
 */
export function pageSizeDoctorLines(
  pageSize: number | undefined,
  ladybugVersion: string | undefined,
): string[] {
  if (pageSize === undefined) return [];
  const lines = [`  ${padDisplayEnd('page size', 10)}${pageSize}`];
  if (pageSize > 4096 && !isPageSizeAwareLadybug(ladybugVersion)) {
    // Don't assert "< 0.18.0" as fact when the version is unresolvable
    // (#2424 review R2) — name the unknown state instead.
    const versionClause =
      ladybugVersion === undefined
        ? 'an unknown @ladybugdb/core version (may predate 0.18.0)'
        : `@ladybugdb/core < 0.18.0`;
    lines.push(
      `  ${padDisplayEnd('', 10)}⚠ non-4K page size with ${versionClause} — ` +
        `'gitnexus analyze' may fail during COPY (#1231). Upgrade gitnexus (npm install -g gitnexus@latest).`,
    );
  }
  return lines;
}

export function repoVectorDoctorStatus(
  meta: RepoMeta | null | undefined,
  liveProbe?: DoctorPoolProbe | null,
): {
  status: string;
  detail: string | null;
} {
  if (!meta) return { status: 'not indexed at this path', detail: null };

  const rawEmbeddingCount = Number(meta.stats?.embeddings ?? 0);
  const embeddingCount =
    Number.isFinite(rawEmbeddingCount) && rawEmbeddingCount > 0 ? Math.floor(rawEmbeddingCount) : 0;
  if (embeddingCount <= 0) return { status: 'not-indexed', detail: null };

  if (liveProbe) {
    if (liveProbe.vectorIndex) {
      return { status: `vector-index (${embeddingCount} chunks)`, detail: null };
    }
    return {
      status: `unavailable (${embeddingCount} chunks)`,
      detail:
        `Live HNSW probe failed (${liveProbe.vectorIndexReason ?? 'pool-probe-unavailable'}). ` +
        'Run gitnexus analyze --embeddings to recreate the named VECTOR index.',
    };
  }

  const vector = meta.capabilities?.vectorSearch;
  if (!vector) {
    return {
      status: 'unknown (refresh index metadata)',
      detail: 'Run gitnexus analyze --embeddings to record the current VECTOR index state.',
    };
  }

  if (vector.status === 'vector-index') {
    return { status: `vector-index (${embeddingCount} chunks)`, detail: null };
  }

  if (vector.status === 'unavailable') {
    return {
      status: `unavailable (${embeddingCount} chunks)`,
      detail: vector.reason ?? 'Semantic vector search is unavailable for this index.',
    };
  }

  const reason = vector.reason ? `${vector.reason} ` : '';
  if (vector.status === 'exact-scan' && embeddingCount > vector.exactScanLimit) {
    return {
      status: `exact-scan refused (${embeddingCount} chunks)`,
      detail:
        `${reason}${embeddingCount} embedding chunks exceed the exact-scan limit of ` +
        `${vector.exactScanLimit}; semantic vector results are skipped until the VECTOR index is restored or the limit is deliberately raised.`,
    };
  }

  return {
    status: `${vector.status} (${embeddingCount} chunks)`,
    detail: `${reason}Exact-scan limit is ${vector.exactScanLimit} chunks.`.trim(),
  };
}

export const doctorCommand = async (
  inputPath?: string,
  options: {
    recoveryPlan?: boolean;
    mcpConfig?: boolean;
    registry?: boolean;
    integrations?: boolean;
    json?: boolean;
    showPaths?: boolean;
  } = {},
) => {
  const selectedModes = [
    options.recoveryPlan,
    options.mcpConfig,
    options.registry,
    options.integrations,
  ].filter(Boolean).length;
  if (selectedModes > 1) {
    throw new Error(
      '--recovery-plan, --mcp-config, --registry, and --integrations are mutually exclusive',
    );
  }
  if (options.showPaths && !options.registry) {
    throw new Error('--show-paths may only be used with --registry');
  }
  if (options.json && !options.mcpConfig && !options.registry && !options.integrations) {
    throw new Error('--json may only be used with --mcp-config, --registry, or --integrations');
  }

  if (options.integrations) {
    const { buildIntegrationDoctorReport } = await import('./integration-doctor.js');
    const report = await buildIntegrationDoctorReport();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('GitNexus integration doctor (read-only)');
      console.log(`  selected CLI:         ${report.selectedCli.version}`);
      console.log(`  Codex/Claude MCP:     ${report.mcp.status}`);
      console.log(`  Claude MCP entries:   ${report.mcp.claudeConfiguredEntries}`);
      console.log(`  Claude hooks:         ${report.hooks.claude}`);
      console.log(
        `  legacy SessionStart:  ${report.hooks.obsoleteSessionStart ? 'present' : 'absent'}`,
      );
    }
    if (report.mcp.status !== 'consistent' || report.hooks.claude !== 'current') {
      process.exitCode = 1;
    }
    return;
  }

  if (options.recoveryPlan) {
    const repoPath = inputPath
      ? path.resolve(inputPath)
      : (getGitRoot(process.cwd()) ?? process.cwd());
    console.log(formatRecoveryPlan(await buildRecoveryPlan(repoPath)));
    return;
  }

  if (options.mcpConfig) {
    const { buildMcpConfigDoctorReport } = await import('./mcp-config-doctor.js');
    const report = await buildMcpConfigDoctorReport();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.valid && report.degraded) {
      console.log('MCP repository policy: degraded (read-only preflight)');
      for (const rejected of report.rejectedEntries) {
        console.log(`  environment: ${rejected.environmentKey}`);
        console.log(`  entry:       ${rejected.entryPosition}`);
        console.log(`  failure:     ${rejected.failureClass}`);
      }
    } else if (report.valid) {
      console.log('MCP repository policy: valid (read-only preflight)');
    } else if ('failureClass' in report) {
      console.log('MCP repository policy: invalid (read-only preflight)');
      console.log(`  environment: ${report.environmentKey}`);
      console.log(`  entry:       ${report.entryPosition}`);
      console.log(`  failure:     ${report.failureClass}`);
    }
    if (!report.valid || report.degraded) process.exitCode = 1;
    return;
  }

  if (options.registry) {
    const { buildRegistryDoctorReport } = await import('./registry-doctor.js');
    const report = await buildRegistryDoctorReport({ showPaths: options.showPaths });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('GitNexus registry doctor (read-only)');
      console.log(`  entries:                 ${report.summary.entries}`);
      console.log(`  remote identities:       ${report.summary.remoteIdentities}`);
      console.log(`  local-only entries:      ${report.summary.localOnlyEntries}`);
      console.log(`  remote collision groups: ${report.summary.remoteCollisionGroups}`);
      console.log(`  alias collision groups:  ${report.summary.aliasCollisionGroups}`);
      console.log(`  count mismatches:         ${report.summary.countMismatches}`);
      console.log(`  recovery states:         ${report.summary.recoveryStateEntries}`);
      console.log(`  database locks:          ${report.summary.lockedEntries}`);
      console.log(`  unsafe storage entries:  ${report.summary.unsafeStorageEntries}`);
      for (const state of ['healthy', 'degraded', 'quarantined'] as const) {
        console.log(
          `  health ${state}:`.padEnd(29) +
            report.entries.filter((entry) => entry.health.state === state).length,
        );
      }
      const reasonCounts = new Map<string, number>();
      for (const entry of report.entries) {
        for (const reason of entry.health.reasons) {
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
      }
      for (const [reason, count] of [...reasonCounts].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        console.log(`  health reason ${reason}: ${count}`);
      }
      if (!options.showPaths) {
        console.log('  paths:                   hidden (use --show-paths to reveal)');
      }
    }
    if (report.entries.some((entry) => entry.health.state !== 'healthy') && !process.exitCode) {
      process.exitCode = 1;
    }
    return;
  }

  const fingerprint = getRuntimeFingerprint();
  const capabilities = getRuntimeCapabilities();
  const embeddingConfig = resolveEmbeddingConfig();
  const requestedPath = inputPath ? path.resolve(inputPath) : process.cwd();
  const repoRoot = getGitRoot(requestedPath) ?? requestedPath;
  const storagePaths = getStoragePaths(repoRoot);
  const repoMeta = await loadMeta(storagePaths.storagePath).catch(() => null);

  console.log(t('doctor.title') + '\n');
  console.log(t('doctor.runtime'));
  console.log(`  ${label('doctor.labels.os', 10)}${fingerprint.platform}/${fingerprint.arch}`);
  console.log(`  ${label('doctor.labels.node', 10)}${fingerprint.node}`);
  console.log(`  ${label('doctor.labels.gitnexus', 10)}${fingerprint.gitnexus}`);
  console.log(`  ${label('doctor.labels.ladybugdb', 10)}${fingerprint.ladybugdb ?? 'unknown'}`);
  // OS page size next to the LadybugDB version because the two interact:
  // @ladybugdb/core < 0.18.0 assumed 4 KiB pages in its buffer manager and
  // crashes mid-COPY on 16 KiB/64 KiB-page kernels (#1231). Literal label
  // (like the 'native' line below) to avoid adding i18n keys.
  for (const line of pageSizeDoctorLines(getOsPageSize(), fingerprint.ladybugdb)) {
    console.log(line);
  }
  const nativeCheck = checkLbugNative();
  if (nativeCheck.ok) {
    console.log(`  ${padDisplayEnd('native', 10)}✓ lbugjs.node loaded`);
  } else {
    console.log(`  ${padDisplayEnd('native', 10)}✗ lbugjs.node missing`);
    process.stderr.write(`\n${nativeCheck.message?.replace(/^/gm, '  ')}\n\n`);
  }
  console.log(`  ${label('doctor.labels.onnx', 10)}${fingerprint.onnxruntime ?? 'unknown'}`);
  console.log('');
  console.log(t('doctor.capabilities'));
  console.log(`  ${label('doctor.labels.graphStore', 18)}${capabilities.graph}`);
  // Live LOAD probe, not the static platform capability — the static value
  // said "available" while analyze failed to load the extension (#2374).
  const poolProbe =
    nativeCheck.ok && repoMeta ? await probeDoctorPool(storagePaths.lbugPath) : null;
  // The aggregate pool verdict is authoritative, but its booleans intentionally
  // contain no native error text. On failure, run the same bounded, offline LOAD
  // diagnostic doctor historically used so remediation remains specific.
  const ftsFailureProbe = poolProbe && !poolProbe.fts ? await probeFtsExtensionLoad() : null;
  const ftsProbe = nativeCheck.ok
    ? poolProbe
      ? {
          loaded: poolProbe.fts,
          reason: poolProbe.fts
            ? undefined
            : ((!ftsFailureProbe?.loaded ? ftsFailureProbe?.reason : undefined) ??
              poolProbe.reason ??
              'FTS did not load on every read-pool connection'),
        }
      : await probeFtsExtensionLoad()
    : { loaded: false, reason: 'LadybugDB native module (lbugjs.node) failed to load' };
  console.log(
    `  ${label('doctor.labels.fullTextSearch', 18)}${ftsProbe.loaded ? 'available' : 'unavailable'}`,
  );
  if (!ftsProbe.loaded && ftsProbe.reason) {
    console.log(`  ${padDisplayEnd('', 18)}${ftsProbe.reason}`);
    // Add an actionable remedy for recognized failure classes (#2374). The
    // Windows missing-dependency case is the point of this: the raw error 126
    // ("specified module could not be found") is opaque, so name the fix (VC++
    // redist, then OpenSSL) instead of leaving the user to reinstall in vain.
    // `unknown`'s remedy is "run doctor", which would be circular here.
    const { kind, remedy } = diagnoseExtensionLoad(ftsProbe.reason);
    if (kind !== 'unknown') {
      console.log(`  ${padDisplayEnd('', 18)}${remedy}`);
    }
  }
  const vectorFailureProbe =
    poolProbe && !poolProbe.vector ? await probeVectorExtensionLoad() : null;
  const vectorProbe = nativeCheck.ok
    ? poolProbe
      ? {
          loaded: poolProbe.vector,
          reason: poolProbe.vector
            ? undefined
            : ((!vectorFailureProbe?.loaded ? vectorFailureProbe?.reason : undefined) ??
              poolProbe.reason ??
              'VECTOR did not load on every read-pool connection'),
        }
      : await probeVectorExtensionLoad()
    : { loaded: false, reason: 'LadybugDB native module (lbugjs.node) failed to load' };
  console.log(
    `  ${label('doctor.labels.vectorIndex', 18)}${vectorProbe.loaded ? 'available' : 'unavailable'}`,
  );
  if (!vectorProbe.loaded && vectorProbe.reason) {
    console.log(`  ${padDisplayEnd('', 18)}${vectorProbe.reason}`);
  }
  if (poolProbe) {
    console.log(
      `  ${padDisplayEnd('Pool connections:', 18)}` +
        (poolProbe.connectionCount > 0
          ? `${poolProbe.exercisedConnections}/${poolProbe.connectionCount} exercised`
          : 'unavailable'),
    );
  }
  console.log(`  ${label('doctor.labels.semanticMode', 18)}${capabilities.semanticMode}`);
  // Surface the optional-extension install policy so offline users can see
  // whether analyze/query will reach the network (extension.ladybugdb.com).
  // Literal label (like the 'native' line) to avoid adding i18n keys.
  const installPolicy = getExtensionInstallPolicy();
  const policyHint =
    installPolicy === 'load-only'
      ? ' (offline; load only, no network install)'
      : installPolicy === 'never'
        ? ' (optional extensions disabled)'
        : ' (installs missing extensions over network)';
  console.log(`  ${padDisplayEnd('Ext install:', 18)}${installPolicy}${policyHint}`);
  console.log(
    `  ${label('doctor.labels.exactScanLimit', 18)}${t('doctor.chunks', { count: capabilities.exactScanLimit })}`,
  );
  if (capabilities.reason)
    console.log(`  ${label('doctor.labels.note', 18)}${capabilities.reason}`);
  const repoVector = repoVectorDoctorStatus(repoMeta, poolProbe);
  console.log(`  ${padDisplayEnd('Repo VECTOR:', 18)}${repoVector.status}`);
  if (repoVector.detail) {
    console.log(`  ${padDisplayEnd('', 18)}${repoVector.detail}`);
  }
  console.log('');
  console.log(t('doctor.embeddings'));
  console.log(`  ${label('doctor.labels.backend', 12)}${isHttpMode() ? 'http' : 'local'}`);
  console.log(`  ${label('doctor.labels.device', 12)}${embeddingConfig.device}`);
  console.log(`  ${label('doctor.labels.threads', 12)}${embeddingConfig.threads}`);
  console.log(
    `  ${label('doctor.labels.batch', 12)}${t('doctor.nodes', { count: embeddingConfig.batchSize })}`,
  );
  console.log(
    `  ${label('doctor.labels.subBatch', 12)}${t('doctor.chunks', { count: embeddingConfig.subBatchSize })}`,
  );
  // Surface local-runtime support so macOS Intel users see up front that local
  // embeddings can't load here (the bundled ONNX Runtime ships no darwin/x64
  // native binding, #1515) — rather than discovering it only when
  // `analyze --embeddings` fails. Literal label like the 'native' line above.
  const support = localEmbeddingDoctorStatus({ httpMode: isHttpMode() });
  console.log(`  ${padDisplayEnd('Support:', 12)}${support.status}`);
  if (support.detail) {
    process.stderr.write(`\n${support.detail.replace(/^/gm, '  ')}\n\n`);
  }
  // Surface the CUDA-build-redirect decision so "why is my CUDA-13 host
  // still on CPU" is visible without digging through debug logs (#2341
  // follow-up). Only meaningful on the local runtime path.
  if (!isHttpMode()) {
    const cudaRedirect = cudaRedirectDoctorStatus();
    console.log(`  ${padDisplayEnd('CUDA:', 12)}${cudaRedirect.status}`);
    if (cudaRedirect.detail) {
      console.log(`  ${padDisplayEnd('', 12)}${cudaRedirect.detail}`);
    }
  }
};
