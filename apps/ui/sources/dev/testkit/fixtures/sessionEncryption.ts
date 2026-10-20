import { sealOwnerSessionDataKeyEnvelope } from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { Encryption } from '@/sync/encryption/encryption';

export function sealSessionDataKeyFixture(params: Readonly<{
    encryption: Encryption;
    dataKey: Uint8Array;
    sessionTag?: string;
}>): string {
    return encodeBase64(sealOwnerSessionDataKeyEnvelope({
        material: { type: 'dataKey', machineKey: params.encryption.getContentPrivateKey() },
        sessionTag: params.sessionTag ?? 'test-session-tag',
        dataKey: params.dataKey,
        randomBytes: getRandomBytes,
    }), 'base64');
}

/**
 * Inject the session-ID binding that owner metadata decryption requires. Row-id
 * substitution (a relay serving another session's consistent row) is rejected at
 * metadata-decrypt time, so fixtures for successful opens must carry the binding
 * for the row's own ID.
 */
export function withSessionKeyBindingForTests(
    metadata: Record<string, unknown>,
    params: Readonly<{ sessionId: string; sessionTag?: string }>,
): Record<string, unknown> {
    return {
        ...metadata,
        sessionKeyBindingV1: {
            v: 1,
            sessionId: params.sessionId,
            sessionTag: params.sessionTag ?? 'test-session-tag',
        },
    };
}

export async function sealBoundSessionRowFixture(params: Readonly<{
    encryption: Encryption;
    sessionId: string;
    dataKey: Uint8Array;
    metadata?: Record<string, unknown>;
    sessionTag?: string;
}>): Promise<{ dataEncryptionKey: string; metadata: string }> {
    const tag = params.sessionTag ?? 'test-session-tag';
    const encryptor = await params.encryption.openEncryption(params.dataKey);
    const [bytes] = await encryptor.encrypt([
        withSessionKeyBindingForTests(params.metadata ?? { path: '/repo' }, { sessionId: params.sessionId, sessionTag: tag }),
    ]);
    return {
        dataEncryptionKey: sealSessionDataKeyFixture({ encryption: params.encryption, dataKey: params.dataKey, sessionTag: tag }),
        metadata: encodeBase64(bytes, 'base64'),
    };
}
