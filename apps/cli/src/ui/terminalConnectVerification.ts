import { computeTerminalConnectConfirmCode } from '@happier-dev/protocol';

/**
 * Prints the client public-key verification code so the user can confirm it
 * matches the code shown on the approving device before approving the link.
 * `log` is injectable for testing.
 */
export function printTerminalConnectVerificationCode(
    keypair: Readonly<{ publicKey: Uint8Array }>,
    log: (msg: string) => void = console.log,
): void {
    const code = computeTerminalConnectConfirmCode(keypair.publicKey);
    log('');
    log(`Verify this code matches the one shown on your device before approving: ${code}`);
    log('');
}
