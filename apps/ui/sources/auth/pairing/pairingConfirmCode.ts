import { computePairingConfirmCode } from '@happier-dev/protocol';

import { computePairingSecretHash } from './pairingSecret';

/**
 * Computes the pairing confirm code locally on the requesting (phone) side.
 * `publicKeyBase64` MUST be the exact string transmitted to the server (standard
 * base64); do not re-encode it, or the code will mismatch the desktop's.
 */
export async function computeLocalPairingConfirmCode(params: Readonly<{
    secret: string;
    publicKeyBase64: string;
}>): Promise<string> {
    const secretHash = await computePairingSecretHash(params.secret);
    return computePairingConfirmCode(secretHash, params.publicKeyBase64);
}
