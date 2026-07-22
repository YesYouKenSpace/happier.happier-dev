import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';

import {
  computePairingConfirmCode,
  computeTerminalConnectConfirmCode,
  confirmCodeFromDigest,
} from './linkConfirmCode.js';

// Independent reference implementation matching the current server formula
// (apps/server/.../registerPairingAuthRoutes.ts computeConfirmCode).
function legacyServerPairingCode(secretHash: string, publicKeyBase64: string): string {
  const digest = createHash('sha256').update(`${secretHash}.${publicKeyBase64}`, 'utf8').digest();
  const n = digest.readUInt32BE(0) % 1_000_000;
  const code = String(n).padStart(6, '0');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

describe('confirmCodeFromDigest', () => {
  test('formats first 4 bytes big-endian as grouped 6 digits', () => {
    const digest = new Uint8Array(32);
    new DataView(digest.buffer).setUint32(0, 123456, false);
    expect(confirmCodeFromDigest(digest)).toBe('123 456');
  });

  test('is independent of the digest byteOffset', () => {
    const backing = new Uint8Array(40);
    new DataView(backing.buffer).setUint32(8, 123456, false);
    const offsetDigest = backing.subarray(8); // byteOffset === 8
    expect(offsetDigest.byteOffset).toBe(8);
    expect(confirmCodeFromDigest(offsetDigest)).toBe('123 456');
  });

  test('zero-pads small values', () => {
    const digest = new Uint8Array(32);
    new DataView(digest.buffer).setUint32(0, 42, false);
    expect(confirmCodeFromDigest(digest)).toBe('000 042');
  });
});

describe('computePairingConfirmCode', () => {
  const cases: ReadonlyArray<{ secretHash: string; publicKeyBase64: string }> = [
    { secretHash: 'abc', publicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    { secretHash: 'k9-secretHashBase64Url', publicKeyBase64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') },
    { secretHash: 'another', publicKeyBase64: Buffer.from(new Uint8Array(32).fill(255)).toString('base64') },
  ];

  test.each(cases)('byte-matches the legacy server formula ($secretHash)', ({ secretHash, publicKeyBase64 }) => {
    expect(computePairingConfirmCode(secretHash, publicKeyBase64)).toBe(
      legacyServerPairingCode(secretHash, publicKeyBase64),
    );
  });

  test('is deterministic', () => {
    expect(computePairingConfirmCode('s', 'p')).toBe(computePairingConfirmCode('s', 'p'));
  });

  test('matches the grouped format', () => {
    expect(computePairingConfirmCode('s', 'p')).toMatch(/^\d{3} \d{3}$/);
  });
});

describe('computeTerminalConnectConfirmCode', () => {
  test('is deterministic and grouped', () => {
    const key = new Uint8Array(32).fill(3);
    const code = computeTerminalConnectConfirmCode(key);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(computeTerminalConnectConfirmCode(new Uint8Array(32).fill(3))).toBe(code);
  });

  test('is domain-separated (differs from a bare sha256(key) code)', () => {
    const key = new Uint8Array(32).fill(3);
    const bare = confirmCodeFromDigest(createHash('sha256').update(Buffer.from(key)).digest());
    expect(computeTerminalConnectConfirmCode(key)).not.toBe(bare);
  });

  test('is independent of the input key byteOffset', () => {
    const key = new Uint8Array(32).fill(9);
    const base = computeTerminalConnectConfirmCode(key);
    const backing = new Uint8Array(40);
    backing.set(key, 8);
    const offsetKey = backing.subarray(8, 40);
    expect(offsetKey.byteOffset).toBe(8);
    expect(computeTerminalConnectConfirmCode(offsetKey)).toBe(base);
  });

  test('different keys generally produce different codes', () => {
    expect(computeTerminalConnectConfirmCode(new Uint8Array(32).fill(1))).not.toBe(
      computeTerminalConnectConfirmCode(new Uint8Array(32).fill(2)),
    );
  });
});
