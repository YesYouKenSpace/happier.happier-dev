import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function isTruthyFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isFalsyFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * Decide whether this build should be stamped with a local build time.
 *
 * - `HAPPIER_STAMP_BUILD_TIME=1` forces a stamp; `=0` forces none.
 * - Otherwise: stamp only when NOT running in CI (release builds run in CI),
 *   so `--version` shows a build time for local developer builds only.
 *
 * Returns `{ builtAt }` to stamp, or `null` to skip.
 */
export function resolveBuildStamp(env = process.env, nowIso = new Date().toISOString()) {
  const override = env.HAPPIER_STAMP_BUILD_TIME;
  if (isTruthyFlag(override)) return { builtAt: nowIso };
  if (isFalsyFlag(override)) return null;

  const inCi = isTruthyFlag(env.CI) || isTruthyFlag(env.GITHUB_ACTIONS);
  return inCi ? null : { builtAt: nowIso };
}

export function resolveDistDir(packageRoot = resolve(__dirname, '..')) {
  return resolve(packageRoot, 'dist');
}

/** Writes dist/build-info.json when this is a local build; no-op otherwise. */
export function writeBuildInfo(options = {}) {
  const env = options.env ?? process.env;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const distDir = resolve(String(options.distDir ?? resolveDistDir()));
  const write = options.writeFileSync ?? writeFileSync;

  const stamp = resolveBuildStamp(env, nowIso);
  if (!stamp) return { written: false };

  const target = resolve(distDir, 'build-info.json');
  write(target, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return { written: true, path: target, builtAt: stamp.builtAt };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const result = writeBuildInfo();
    if (result.written) {
      console.log(`[build-info] stamped local build time: ${result.builtAt}`);
    } else {
      console.log('[build-info] release/CI build — no build time stamped');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
