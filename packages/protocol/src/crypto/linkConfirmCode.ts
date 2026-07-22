import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

const TERMINAL_CONNECT_DOMAIN = 'happier:terminal-connect:v1';

/**
 * WHY: reads the first 4 digest bytes big-endian. `@noble/hashes` may return a
 * Uint8Array whose `byteOffset` is nonzero, so we must pass `byteOffset`/length
 * into DataView rather than using `new DataView(d.buffer)` (which would read the
 * wrong bytes on some runtimes).
 */
export function confirmCodeFromDigest(digest: Uint8Array): string {
  const view = new DataView(digest.buffer, digest.byteOffset, 4);
  const n = view.getUint32(0, false) % 1_000_000;
  const code = String(n).padStart(6, '0');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * Pairing confirm code. Byte-identical to the server formula so displayed codes
 * are unchanged. `secretHash` is base64url; `publicKeyBase64` MUST be the exact
 * base64 string the requesting device transmitted.
 */
export function computePairingConfirmCode(secretHash: string, publicKeyBase64: string): string {
  return confirmCodeFromDigest(sha256(utf8ToBytes(`${secretHash}.${publicKeyBase64}`)));
}

/**
 * Terminal-login confirm code. Domain-separated hash of the raw public key bytes
 * (encoding-agnostic).
 */
export function computeTerminalConnectConfirmCode(publicKey: Uint8Array): string {
  const prefix = utf8ToBytes(TERMINAL_CONNECT_DOMAIN);
  const input = new Uint8Array(prefix.length + publicKey.length);
  input.set(prefix, 0);
  input.set(publicKey, prefix.length);
  return confirmCodeFromDigest(sha256(input));
}
