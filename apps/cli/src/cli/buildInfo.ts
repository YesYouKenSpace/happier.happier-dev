import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Local build metadata. `build-info.json` is written next to the bundle by the
 * local build (`scripts/writeBuildInfo.mjs`) and is intentionally absent from
 * release/CI builds, so `--version` only shows a build time for local builds.
 */
export type LocalBuildInfo = Readonly<{ builtAt: string }>;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a Date as local `YYYY-MM-DD HH:mm:ss` (no locale/tz-name dependence). */
export function formatLocalBuildTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Compose the `--version` output. The version stays on the FIRST line so the
 * daemon's first-line version parser (resolveCliVersionFromBinary) is unaffected;
 * the local build time, when present and valid, is appended on a second line.
 */
export function formatVersionOutput(version: string, builtAt: string | null): string {
  if (!builtAt) return version;
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return version;
  return `${version}\nbuilt ${formatLocalBuildTime(date)}`;
}

/**
 * Best-effort read of the local build-info file. Returns null for release builds
 * (file absent) or if it cannot be read/parsed. Tries a few locations because the
 * bundler may place the compiled module at different depths under dist/.
 */
export function readLocalBuildInfo(): LocalBuildInfo | null {
  const candidates = ['./build-info.json', '../build-info.json', '../../build-info.json'];
  for (const rel of candidates) {
    try {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { builtAt?: unknown }).builtAt === 'string') {
        return { builtAt: (parsed as { builtAt: string }).builtAt };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
