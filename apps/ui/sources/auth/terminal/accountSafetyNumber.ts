import { accountSafetyNumberFromPrivateKey } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveTerminalProvisioningContentPrivateKey } from './resolveContentPrivateKey';

/** Account safety number the approver displays; null if credentials are unusable. */
export function accountSafetyNumberForCredentials(credentials: AuthCredentials): string | null {
    try {
        return accountSafetyNumberFromPrivateKey(resolveTerminalProvisioningContentPrivateKey(credentials));
    } catch {
        return null;
    }
}
