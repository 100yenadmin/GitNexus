import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

export interface NativeCheckResult {
  ok: boolean;
  binaryPath?: string;
  message?: string;
}

export function checkLbugNative(overridePkgDir?: string): NativeCheckResult {
  let pkgDir: string;

  if (overridePkgDir) {
    pkgDir = overridePkgDir;
  } else {
    try {
      const _require = createRequire(import.meta.url);
      const mainEntry = _require.resolve('@ladybugdb/core');
      pkgDir = path.dirname(mainEntry);
    } catch {
      return {
        ok: false,
        message: [
          'LadybugDB package (@ladybugdb/core) is not installed.',
          '',
          'Run:  npm install',
        ].join('\n'),
      };
    }
  }

  const binaryPath = path.join(pkgDir, 'lbugjs.node');
  if (!fs.existsSync(binaryPath)) {
    return {
      ok: false,
      binaryPath,
      message: [
        'LadybugDB native binary (lbugjs.node) is missing.',
        '',
        'This usually happens when the install lifecycle script was skipped.',
        '',
        'To repair:',
        `  node ${path.join(pkgDir, 'install.js')}`,
        '',
        'Common causes:',
        '  - pnpm dlx / pnpx skip build scripts by default (security model).',
        '      Install the exact Electric GitHub release tarball with build scripts enabled:',
        '      npm install -g /path/to/gitnexus-1.6.10-electric.10.tgz',
        '      # Or with pnpm 10.2+:',
        '      pnpm add -g --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter /path/to/gitnexus-1.6.10-electric.10.tgz',
        '  - bun: add to package.json and reinstall:',
        '      "trustedDependencies": ["@ladybugdb/core"]',
        '  - npm configured with ignore-scripts=true',
        '    (in .npmrc or via --ignore-scripts).',
      ].join('\n'),
    };
  }

  try {
    const _require = createRequire(import.meta.url);
    _require(binaryPath);
  } catch (err: unknown) {
    const nativeError = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      binaryPath,
      message: [
        'LadybugDB native binary (lbugjs.node) exists but failed to load:',
        `  ${nativeError}`,
        '',
        'This can happen with a truncated file, ABI mismatch, or wrong-platform binary.',
        '',
        'To repair:',
        `  node ${path.join(pkgDir, 'install.js')}`,
        '',
        'If install scripts were skipped (pnpm dlx / pnpx / ignore-scripts):',
        '  npm install -g /path/to/gitnexus-1.6.10-electric.10.tgz',
        '  pnpm add -g --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter /path/to/gitnexus-1.6.10-electric.10.tgz',
        '',
        'If using bun, add to package.json and reinstall:',
        '  "trustedDependencies": ["@ladybugdb/core"]',
      ].join('\n'),
    };
  }

  return { ok: true, binaryPath };
}

export interface FtsProbeResult {
  loaded: boolean;
  /** Collapsed LadybugDB error when `loaded` is false. */
  reason?: string;
}

const DEFAULT_EXTENSION_PROBE_TIMEOUT_MS = 10_000;

/** A LadybugDB query result exposes a synchronous `close()`. */
interface CloseableResult {
  close(): void;
}

/** Close each result, swallowing close-time errors so a successful LOAD is not
 *  misreported as a failure (native-check keeps no static lbug dependency, so it
 *  cannot reuse the adapter's closeQueryResults — that would eagerly load the
 *  module and defeat the dynamic import below). */
const closeProbeResults = (result: unknown): void => {
  for (const r of Array.isArray(result) ? result : [result]) {
    try {
      (r as CloseableResult)?.close?.();
    } catch {
      // ignore — a close failure must not flip a successful LOAD to failed
    }
  }
};

/**
 * Live-probe `LOAD EXTENSION fts` on a throwaway in-memory database.
 *
 * `doctor` used to print the static platform capability, which contradicted
 * analyze whenever the extension file was missing or unloadable (#2374).
 * LOAD never touches the network, so the probe is safe offline, and it
 * surfaces LadybugDB's real error — which distinguishes a missing extension
 * file from a present-but-broken one (wrong platform, truncated download).
 * Dynamic import so doctor still runs when the native module itself is broken.
 *
 * Bounded by `timeoutMs`: an unresponsive extension file (e.g. on a hung
 * network home dir) must never freeze `doctor` — the tool the degradation
 * warnings send users to. `Promise.race` lets doctor report and move on; it
 * cannot cancel an in-flight native call, so a future thread-blocking case
 * would need an out-of-process probe.
 */
async function probeExtensionLoad(
  extensionName: 'fts' | 'VECTOR',
  timeoutMs: number,
): Promise<FtsProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FtsProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          loaded: false,
          reason: 'probe timed out — extension file or filesystem unresponsive',
        }),
      timeoutMs,
    );
  });

  const probe = (async (): Promise<FtsProbeResult> => {
    try {
      const { default: lbug } = await import('@ladybugdb/core');
      const db = new lbug.Database(':memory:');
      // Nested finallys so `db` is closed even if the Connection ctor throws.
      try {
        const conn = new lbug.Connection(db);
        try {
          const result = await conn.query(`LOAD EXTENSION ${extensionName}`);
          closeProbeResults(result);
          return { loaded: true };
        } finally {
          await conn.close().catch(() => {});
        }
      } finally {
        await db.close().catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { loaded: false, reason: message.replace(/\s+/g, ' ').trim() };
    }
  })();

  return await Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
}

export async function probeFtsExtensionLoad(
  timeoutMs: number = DEFAULT_EXTENSION_PROBE_TIMEOUT_MS,
): Promise<FtsProbeResult> {
  return probeExtensionLoad('fts', timeoutMs);
}

/** Live, load-only VECTOR probe for doctor. Never attempts a network install. */
export async function probeVectorExtensionLoad(
  timeoutMs: number = DEFAULT_EXTENSION_PROBE_TIMEOUT_MS,
): Promise<FtsProbeResult> {
  if (process.platform === 'win32') {
    return {
      loaded: false,
      reason: 'VECTOR is disabled on Windows because loading/installing the extension can crash',
    };
  }
  return probeExtensionLoad('VECTOR', timeoutMs);
}
