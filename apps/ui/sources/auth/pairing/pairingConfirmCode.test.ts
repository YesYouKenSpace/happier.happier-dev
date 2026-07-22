import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';

import { computeLocalPairingConfirmCode } from './pairingConfirmCode';

// End-to-end cross-side check: the phone's local computation must equal the
// server/desktop formula fed with the phone's transmitted base64 key string and
// a secretHash derived (base64url) from the same secret.
function legacyServerPairingCode(secretHash: string, publicKeyBase64: string): string {
  const digest = createHash('sha256').update(`${secretHash}.${publicKeyBase64}`, 'utf8').digest();
  const n = digest.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0').replace(/^(\d{3})(\d{3})$/, '$1 $2');
}

describe('computeLocalPairingConfirmCode', () => {
  const cases = [
    { secret: 'super-secret-1', publicKeyBase64: Buffer.from(new Uint8Array(32).fill(4)).toString('base64') },
    { secret: 'AnotherSecret_2', publicKeyBase64: Buffer.from(new Uint8Array(32).fill(200)).toString('base64') },
  ];

  test.each(cases)('matches the server formula for secret=$secret', async ({ secret, publicKeyBase64 }) => {
    const secretHash = createHash('sha256').update(secret, 'utf8').digest('base64url');
    const expected = legacyServerPairingCode(secretHash, publicKeyBase64);
    expect(await computeLocalPairingConfirmCode({ secret, publicKeyBase64 })).toBe(expected);
  });
});
