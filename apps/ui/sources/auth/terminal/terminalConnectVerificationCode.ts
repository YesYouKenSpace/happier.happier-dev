import { computeTerminalConnectConfirmCode, BOX_BUNDLE_PUBLIC_KEY_BYTES } from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';

/**
 * Computes the 6-digit verification code for the terminal's public key extracted
 * from a connect URL. Returns null if the key cannot be decoded or has an
 * unexpected size. `decodeBase64` is lenient and never throws, so we validate
 * the decoded byte length to reject garbage inputs instead of producing a
 * misleading code.
 */
export function terminalConnectVerificationCodeFromB64Url(publicKeyB64Url: string): string | null {
    try {
        const keyBytes = decodeBase64(publicKeyB64Url, 'base64url');
        if (keyBytes.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) return null;
        return computeTerminalConnectConfirmCode(keyBytes);
    } catch {
        return null;
    }
}
