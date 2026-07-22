import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function publicPath(rel: string): string {
  return fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
}

function readManifest(): any {
  return JSON.parse(readFileSync(publicPath('manifest.webmanifest'), 'utf8'));
}

describe('web app manifest', () => {
  test('is valid JSON with the required standalone-install fields', () => {
    const m = readManifest();
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
  });

  test('declares 192 and 512 png icons', () => {
    const m = readManifest();
    const bySize: Record<string, any> = Object.fromEntries(
      (m.icons ?? []).map((i: any) => [i.sizes, i]),
    );
    for (const size of ['192x192', '512x512']) {
      expect(bySize[size]).toBeTruthy();
      expect(bySize[size].type).toBe('image/png');
    }
  });

  test('every referenced icon file exists in public/', () => {
    const m = readManifest();
    for (const icon of m.icons ?? []) {
      const rel = String(icon.src).replace(/^\//, '');
      expect(existsSync(publicPath(rel))).toBe(true);
    }
    // apple-touch-icon is referenced from +html.tsx (Task 2), not the manifest,
    // but must exist as an asset.
    expect(existsSync(publicPath('apple-touch-icon.png'))).toBe(true);
  });
});
