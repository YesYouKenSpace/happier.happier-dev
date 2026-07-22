import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import tweetnacl from 'tweetnacl';

import { SAFETY_NUMBER_WORDLIST } from './safetyNumberWordlist.js';

const DOMAIN = 'happier:account-safety-number:v1';
const WORD_COUNT = 6; // 6 * 11 bits = 66 bits (>= 64-bit target)
const BITS_PER_WORD = 11; // 2^11 === SAFETY_NUMBER_WORDLIST.length

/** Read `len` bits from `bytes` starting at bit offset `start`, MSB-first. */
function readBits(bytes: Uint8Array, start: number, len: number): number {
  let value = 0;
  for (let i = 0; i < len; i++) {
    const bit = start + i;
    const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
    value = (value << 1) | b;
  }
  return value;
}

export function deriveContentPublicKey(contentPrivateKey: Uint8Array): Uint8Array {
  return tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey;
}

export function accountSafetyNumber(contentPublicKey: Uint8Array): string {
  const prefix = utf8ToBytes(DOMAIN);
  const input = new Uint8Array(prefix.length + contentPublicKey.length);
  input.set(prefix, 0);
  input.set(contentPublicKey, prefix.length);
  const digest = sha256(input);
  const words: string[] = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    words.push(SAFETY_NUMBER_WORDLIST[readBits(digest, i * BITS_PER_WORD, BITS_PER_WORD)] as string);
  }
  return words.join('-');
}

export function accountSafetyNumberFromPrivateKey(contentPrivateKey: Uint8Array): string {
  return accountSafetyNumber(deriveContentPublicKey(contentPrivateKey));
}

export { SAFETY_NUMBER_WORDLIST } from './safetyNumberWordlist.js';
