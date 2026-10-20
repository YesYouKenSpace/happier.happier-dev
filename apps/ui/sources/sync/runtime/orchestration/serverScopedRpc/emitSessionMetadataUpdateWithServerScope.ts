import { apiSocket } from '@/sync/api/session/apiSocket';
import type { UpdateMetadataAck } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';
import { raceSocketIoAckTimeout } from '@/sync/runtime/socketIoAckTimeout';
import { storage } from '@/sync/domains/state/storage';
import { assertUiSessionEncryptionModeAllowed, resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { assertScopedUiSessionEncryptionModeAllowed } from '@/sync/domains/settings/scopedClientEncryptionRequirement';
import type { SessionEncryptionMode } from '@happier-dev/protocol';

import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { resolvePreferredServerIdForSessionId } from './resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

export async function emitSessionMetadataUpdateWithServerScope(params: Readonly<{
    sessionId: string;
    encryptionMode: SessionEncryptionMode;
    expectedVersion: number;
    metadata: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<UpdateMetadataAck> {
    const context = await resolveServerScopedSessionContext({
        serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0
            ? params.serverId.trim()
            : resolvePreferredServerIdForSessionId(params.sessionId),
        timeoutMs: params.timeoutMs,
    });
    const assertEncryptionRequirement = () => {
        if (context.scope === 'scoped') {
            assertScopedUiSessionEncryptionModeAllowed({
                mode: params.encryptionMode,
                serverId: context.targetServerId,
                accountId: context.targetAccountId,
            });
            return;
        }
        const settings = storage.getState().settings;
        assertUiSessionEncryptionModeAllowed({
            mode: params.encryptionMode,
            requirement: resolveUiClientEncryptionRequirement({ syncedSettings: settings, localSettings: settings }),
        });
    };
    const payload = {
        sid: params.sessionId,
        expectedVersion: params.expectedVersion,
        metadata: params.metadata,
    };

    if (context.scope === 'active') {
        assertEncryptionRequirement();
        return await apiSocket.emitWithAck<UpdateMetadataAck>('update-metadata', payload, { timeoutMs: context.timeoutMs });
    }

    const socket = await createEphemeralServerSocketClient({
        serverUrl: context.targetServerUrl,
        token: context.token,
        timeoutMs: context.timeoutMs,
    });
    try {
        assertEncryptionRequirement();
        return await raceSocketIoAckTimeout(
            socket.timeout(context.timeoutMs).emitWithAck('update-metadata', payload) as Promise<UpdateMetadataAck>,
            context.timeoutMs,
        );
    } finally {
        socket.disconnect();
    }
}
