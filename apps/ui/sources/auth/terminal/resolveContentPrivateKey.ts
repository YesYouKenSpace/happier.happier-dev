import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';
import { isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';

export function resolveTerminalProvisioningContentPrivateKey(credentials: AuthCredentials): Uint8Array {
    if (!isLegacyAuthCredentials(credentials)) {
        const machineKey = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (machineKey.length !== 32) {
            throw new Error('Invalid dataKey credential key lengths');
        }
        return machineKey;
    }

    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    return deriveAccountMachineKeyFromRecoverySecret(secretKey);
}
