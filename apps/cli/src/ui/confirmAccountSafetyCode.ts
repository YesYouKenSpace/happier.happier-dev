import { createInterface } from 'node:readline';

import { accountSafetyNumberFromPrivateKey, deriveAccountMachineKeyFromRecoverySecret as deriveAccountContentKeyFromSecret } from '@happier-dev/protocol';

/**
 * Computes the account safety code from the decrypted terminal-provisioning
 * response. Legacy = 32-byte account secret (content key = derived from secret);
 * v2 = 0x00 || 32-byte machineKey. Returns null for anything else.
 */
export function accountSafetyNumberForDecryptedResponse(decrypted: Uint8Array): string | null {
  if (decrypted.length === 32) {
    return accountSafetyNumberFromPrivateKey(deriveAccountContentKeyFromSecret(decrypted));
  }
  if (decrypted.length >= 33 && decrypted[0] === 0) {
    return accountSafetyNumberFromPrivateKey(decrypted.slice(1, 33));
  }
  return null;
}

/** Normalize a typed safety code for forgiving comparison: lowercase, and collapse any run of whitespace/hyphens to a single space. */
export function normalizeSafetyCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

/**
 * Reads one line, resolving on either the entered line OR stream close/EOF.
 * Resolving on 'close' is deliberate: if stdin can't deliver a line (closed/EOF),
 * we must resolve (→ caller fails closed) rather than leave an unresolved await
 * that lets the process silently exit when the event loop drains. `input` is
 * resumed in case a prior UI (e.g. Ink) left it paused.
 */
export function promptLine(
  question: string,
  io?: Readonly<{ input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }>,
): Promise<string> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;
  return new Promise((resolve) => {
    // Fully revive stdin for line reading. A prior UI (Ink method selector) can
    // leave it paused/raw/unref'd; without this the process can silently exit
    // when the event loop drains instead of waiting for input.
    const s = input as {
      ref?: () => void; resume?: () => void; isTTY?: boolean;
      setRawMode?: (v: boolean) => void; setEncoding?: (e: string) => void;
    };
    try { s.ref?.(); } catch { /* best-effort */ }
    try { s.resume?.(); } catch { /* best-effort */ }
    try { if (s.isTTY && typeof s.setRawMode === 'function') s.setRawMode(false); } catch { /* best-effort */ }
    try { s.setEncoding?.('utf8'); } catch { /* best-effort */ }

    const rl = createInterface({ input, output });
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch { /* best-effort */ }
      resolve(value);
    };
    rl.on('close', () => finish(''));
    rl.question(question, (answer) => finish(answer));
  });
}

/**
 * Requires the user to TYPE the account safety code shown in the approving app.
 * The CLI deliberately does NOT display its own computed code — the user must
 * read it from the app and enter it, which forces a real cross-device
 * comparison. The typed value is matched (normalized) against the code the CLI
 * computed from what it received; a mismatch means a different account was
 * delivered (e.g. a malicious relay), and linking is aborted.
 *
 * Non-interactive terminals fail closed unless the caller explicitly opts out
 * via `skip` (the `happier auth login --skip-account-safety-code` flag), which
 * proceeds WITHOUT verification — intended only for linking against an approving
 * app too old to display the code.
 */
export async function confirmAccountSafetyCode(params: Readonly<{
  expected: string;
  isInteractive: boolean;
  skip?: boolean;
  maxAttempts?: number;
  log?: (message: string) => void;
  ask?: (question: string) => Promise<string>;
}>): Promise<boolean> {
  const log = params.log ?? console.log;
  const maxAttempts = params.maxAttempts ?? 3;
  if (params.skip) {
    log('');
    log('⚠  Skipping account safety code verification (--skip-account-safety-code).');
    log('Linking will proceed WITHOUT verifying the account. Only use this when the approving app is too old to show the code.');
    return true;
  }
  log('');
  log('To finish linking, enter the account safety code shown in the Happier app.');
  if (!params.isInteractive) {
    log('Cannot confirm in a non-interactive terminal. Aborting linking for your safety.');
    log('Re-run linking in an interactive terminal.');
    return false;
  }
  const ask = params.ask ?? promptLine;
  const target = normalizeSafetyCode(params.expected);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = await ask('Account safety code from the app: ');
    if (normalizeSafetyCode(answer) === target) {
      return true;
    }
    const remaining = maxAttempts - attempt;
    if (remaining > 0) {
      log(`That does not match. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
    }
  }
  log('Account safety code did not match. No credentials were saved.');
  return false;
}
