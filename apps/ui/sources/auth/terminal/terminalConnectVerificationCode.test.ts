import { describe, expect, test } from 'vitest';
import { computeTerminalConnectConfirmCode } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';

import { terminalConnectVerificationCodeFromB64Url } from './terminalConnectVerificationCode';

describe('terminalConnectVerificationCodeFromB64Url', () => {
  test('matches the protocol helper for a valid base64url key', () => {
    const keyBytes = new Uint8Array(32).fill(5);
    const b64url = encodeBase64(keyBytes, 'base64url');
    expect(terminalConnectVerificationCodeFromB64Url(b64url)).toBe(
      computeTerminalConnectConfirmCode(keyBytes),
    );
  });

  test('returns null for an undecodable input', () => {
    expect(terminalConnectVerificationCodeFromB64Url('!!!not-base64!!!')).toBeNull();
  });
});
