import { describe, expect, test } from 'vitest';
import { accountSafetyNumberFromPrivateKey } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';

import { accountSafetyNumberForCredentials } from './accountSafetyNumber';

describe('accountSafetyNumberForCredentials', () => {
    test('dataKey credentials match the protocol helper over machineKey', () => {
        const machineKey = new Uint8Array(32).fill(6);
        const credentials = {
            token: 't',
            encryption: { machineKey: encodeBase64(machineKey, 'base64'), publicKey: encodeBase64(new Uint8Array(32), 'base64') },
        } as any;
        expect(accountSafetyNumberForCredentials(credentials)).toBe(accountSafetyNumberFromPrivateKey(machineKey));
    });

    test('returns null for malformed credentials', () => {
        expect(accountSafetyNumberForCredentials({} as any)).toBeNull();
    });
});
