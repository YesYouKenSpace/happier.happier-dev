import { describe, expect, test } from 'vitest';
import { computeTerminalConnectConfirmCode } from '@happier-dev/protocol';

import { printTerminalConnectVerificationCode } from './terminalConnectVerification';

describe('printTerminalConnectVerificationCode', () => {
  test('emits a line containing the protocol-derived code', () => {
    const publicKey = new Uint8Array(32).fill(1);
    const expected = computeTerminalConnectConfirmCode(publicKey);
    const lines: string[] = [];

    printTerminalConnectVerificationCode({ publicKey }, (m) => lines.push(m));

    expect(lines.some((l) => l.includes(expected))).toBe(true);
  });
});
