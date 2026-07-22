import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { accountSafetyNumberFromPrivateKey, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import {
  accountSafetyNumberForDecryptedResponse,
  confirmAccountSafetyCode,
  normalizeSafetyCode,
  promptLine,
} from './confirmAccountSafetyCode';

describe('accountSafetyNumberForDecryptedResponse', () => {
  test('legacy (32 bytes) hashes the derived content key', () => {
    const secret = new Uint8Array(32).fill(9);
    expect(accountSafetyNumberForDecryptedResponse(secret)).toBe(
      accountSafetyNumberFromPrivateKey(deriveAccountMachineKeyFromRecoverySecret(secret)),
    );
  });

  test('v2 (0x00 || machineKey) hashes the machineKey', () => {
    const machineKey = new Uint8Array(32).fill(4);
    const decrypted = new Uint8Array(33);
    decrypted[0] = 0;
    decrypted.set(machineKey, 1);
    expect(accountSafetyNumberForDecryptedResponse(decrypted)).toBe(
      accountSafetyNumberFromPrivateKey(machineKey),
    );
  });

  test('returns null for an unrecognized blob', () => {
    const bad = new Uint8Array(10);
    bad[0] = 5;
    expect(accountSafetyNumberForDecryptedResponse(bad)).toBeNull();
  });
});

describe('normalizeSafetyCode', () => {
  test.each([
    ['rent-eternal-wealth', 'rent eternal wealth'],
    ['Rent-Eternal-Wealth', 'rent eternal wealth'],
    ['  rent   eternal  wealth  ', 'rent eternal wealth'],
    ['RENT ETERNAL WEALTH', 'rent eternal wealth'],
    ['rent - eternal - wealth', 'rent eternal wealth'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSafetyCode(input)).toBe(expected);
  });
});

describe('promptLine', () => {
  test('resolves the entered line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = promptLine('code: ', { input, output });
    input.write('rent eternal wealth\n');
    expect(await p).toBe('rent eternal wealth');
  });

  test('resolves empty string on EOF/close instead of hanging (fail-closed, no silent exit)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = promptLine('code: ', { input, output });
    input.end();
    expect(await p).toBe('');
  });
});

describe('confirmAccountSafetyCode', () => {
  const expected = 'rent-eternal-wealth-below-wink-salute';

  function harness(answers: string[]) {
    const logs: string[] = [];
    let asked = 0;
    const ask = async () => answers[asked++] ?? '';
    return { logs, ask: ask as (q: string) => Promise<string>, log: (m: string) => { logs.push(m); }, get asked() { return asked; } };
  }

  test('non-interactive fails closed without asking', async () => {
    const h = harness(['rent-eternal-wealth-below-wink-salute']);
    const ok = await confirmAccountSafetyCode({ expected, isInteractive: false, log: h.log, ask: h.ask });
    expect(ok).toBe(false);
    expect(h.asked).toBe(0);
  });

  test('accepts the exact code typed from the app', async () => {
    const h = harness([expected]);
    expect(await confirmAccountSafetyCode({ expected, isInteractive: true, log: h.log, ask: h.ask })).toBe(true);
  });

  test('accepts a differently-formatted but correct code (spaces/case)', async () => {
    const h = harness(['RENT ETERNAL WEALTH BELOW WINK SALUTE']);
    expect(await confirmAccountSafetyCode({ expected, isInteractive: true, log: h.log, ask: h.ask })).toBe(true);
  });

  test('allows retries: wrong then right within the limit', async () => {
    const h = harness(['nope-wrong-code-here-bad-word', expected]);
    expect(await confirmAccountSafetyCode({ expected, isInteractive: true, maxAttempts: 3, log: h.log, ask: h.ask })).toBe(true);
    expect(h.asked).toBe(2);
  });

  test('fails closed after all attempts are wrong', async () => {
    const h = harness(['a', 'b', 'c']);
    expect(await confirmAccountSafetyCode({ expected, isInteractive: true, maxAttempts: 3, log: h.log, ask: h.ask })).toBe(false);
    expect(h.asked).toBe(3);
  });

  test('never prints the expected code (user must read it from the app)', async () => {
    const h = harness(['wrong', 'wrong', 'wrong']);
    await confirmAccountSafetyCode({ expected, isInteractive: true, maxAttempts: 3, log: h.log, ask: h.ask });
    expect(h.logs.join('\n')).not.toContain(expected);
    expect(h.logs.join('\n')).not.toContain(normalizeSafetyCode(expected));
  });
});
