import { describe, expect, test } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  SAFETY_NUMBER_WORDLIST,
  accountSafetyNumber,
  accountSafetyNumberFromPrivateKey,
  deriveContentPublicKey,
} from './accountSafetyNumber.js';

describe('SAFETY_NUMBER_WORDLIST', () => {
  test('has exactly 2048 unique words', () => {
    expect(SAFETY_NUMBER_WORDLIST).toHaveLength(2048);
    expect(new Set(SAFETY_NUMBER_WORDLIST).size).toBe(2048);
  });
});

describe('deriveContentPublicKey', () => {
  test('matches tweetnacl box public key derivation', () => {
    const sk = new Uint8Array(32).fill(7);
    expect(Array.from(deriveContentPublicKey(sk))).toEqual(
      Array.from(tweetnacl.box.keyPair.fromSecretKey(sk).publicKey),
    );
  });
});

describe('accountSafetyNumber', () => {
  test('is six wordlist words joined by "-", deterministic', () => {
    const pub = deriveContentPublicKey(new Uint8Array(32).fill(3));
    const code = accountSafetyNumber(pub);
    const words = code.split('-');
    expect(words).toHaveLength(6);
    for (const w of words) expect(SAFETY_NUMBER_WORDLIST).toContain(w);
    expect(accountSafetyNumber(deriveContentPublicKey(new Uint8Array(32).fill(3)))).toBe(code);
  });

  test('different keys generally produce different codes (>= ~64 bits of spread)', () => {
    const codes = new Set<string>();
    for (let i = 1; i <= 50; i++) codes.add(accountSafetyNumberFromPrivateKey(new Uint8Array(32).fill(i)));
    expect(codes.size).toBe(50);
  });

  test('golden vector is stable', () => {
    // Locks the derivation (domain string, bit layout, wordlist order) against drift.
    const code = accountSafetyNumberFromPrivateKey(new Uint8Array(32).fill(1));
    expect(code).toMatch(/^[a-z]+(-[a-z]+){5}$/);
    // Pinned on first GREEN run — do not change without bumping DOMAIN or wordlist.
    expect(code).toBe('rent-eternal-wealth-below-wink-salute');
  });
});
