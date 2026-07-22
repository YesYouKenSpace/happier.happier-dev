import { describe, expect, test } from 'vitest';

import { formatLocalBuildTime, formatVersionOutput } from './buildInfo';

function expectedLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe('formatLocalBuildTime', () => {
  test('formats a Date as local YYYY-MM-DD HH:mm:ss', () => {
    const d = new Date('2026-07-21T06:32:07.000Z');
    expect(formatLocalBuildTime(d)).toBe(expectedLocal(d));
  });

  test('matches the fixed shape', () => {
    expect(formatLocalBuildTime(new Date('2026-01-02T03:04:05.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('formatVersionOutput', () => {
  test('returns the plain version when builtAt is null (release builds)', () => {
    expect(formatVersionOutput('0.2.1', null)).toBe('0.2.1');
  });

  test('appends the build time on a SECOND line so first-line version parsers stay intact', () => {
    const iso = '2026-07-21T06:32:07.000Z';
    const out = formatVersionOutput('0.2.1', iso);
    const lines = out.split('\n');
    expect(lines[0]).toBe('0.2.1');
    expect(lines[1]).toBe(`built ${formatLocalBuildTime(new Date(iso))}`);
    expect(lines).toHaveLength(2);
  });

  test('ignores an unparseable builtAt and returns the plain version', () => {
    expect(formatVersionOutput('0.2.1', 'not-a-date')).toBe('0.2.1');
  });
});
