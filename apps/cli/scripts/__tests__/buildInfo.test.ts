import { describe, expect, test } from 'vitest';

// @ts-expect-error - .mjs build script without type declarations (matches sibling script tests)
import { resolveBuildStamp } from '../writeBuildInfo.mjs';

const ISO = '2026-07-21T06:32:07.000Z';

describe('resolveBuildStamp', () => {
  test('stamps local (non-CI) builds', () => {
    expect(resolveBuildStamp({}, ISO)).toEqual({ builtAt: ISO });
  });

  test('does not stamp CI/release builds', () => {
    expect(resolveBuildStamp({ CI: 'true' }, ISO)).toBeNull();
    expect(resolveBuildStamp({ CI: '1' }, ISO)).toBeNull();
    expect(resolveBuildStamp({ GITHUB_ACTIONS: 'true' }, ISO)).toBeNull();
  });

  test('treats falsy CI values as local', () => {
    expect(resolveBuildStamp({ CI: '' }, ISO)).toEqual({ builtAt: ISO });
    expect(resolveBuildStamp({ CI: '0' }, ISO)).toEqual({ builtAt: ISO });
    expect(resolveBuildStamp({ CI: 'false' }, ISO)).toEqual({ builtAt: ISO });
  });

  test('honors the explicit override in both directions', () => {
    expect(resolveBuildStamp({ CI: 'true', HAPPIER_STAMP_BUILD_TIME: '1' }, ISO)).toEqual({ builtAt: ISO });
    expect(resolveBuildStamp({ HAPPIER_STAMP_BUILD_TIME: '0' }, ISO)).toBeNull();
  });
});
