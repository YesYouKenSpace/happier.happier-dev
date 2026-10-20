import {
    combineClientEncryptionRequirements,
    type ClientEncryptionRequirement,
    type SessionEncryptionMode,
} from '@happier-dev/protocol';

import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';

import { assertUiSessionEncryptionModeAllowed, resolveUiClientEncryptionRequirement } from './clientEncryptionRequirement';

export function isUiClientEncryptionRequirementUnavailableError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'CLIENT_ENCRYPTION_REQUIREMENT_UNAVAILABLE';
}

function resolveActiveClientEncryptionRequirement(): ClientEncryptionRequirement {
    const settings = storage.getState().settings;
    return resolveUiClientEncryptionRequirement({ syncedSettings: settings, localSettings: settings });
}

/**
 * Resolve the encryption requirement governing a scoped operation against a target server.
 *
 * Strongest-wins across the active device pin and the target account's own persisted record,
 * mirroring the CLI's requirement combination: a floor selected on this device must not be
 * weakened by another server's record, and a stricter pin stored for the target account must
 * not be bypassed by the active profile's opt-out. A target scope with no locally persisted
 * record has an unknowable floor; returning null keeps that decision fail-closed instead of
 * borrowing the active profile's opt-out.
 */
export function resolveScopedClientEncryptionRequirement(params: Readonly<{
    serverId: string;
    accountId: string;
}>): ClientEncryptionRequirement | null {
    const activeRequirement = resolveActiveClientEncryptionRequirement();
    const targetServerId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const targetAccountId = typeof params.accountId === 'string' ? params.accountId.trim() : '';
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!targetServerId || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId)) {
        return activeRequirement;
    }
    if (!targetAccountId) {
        return null;
    }

    const scope = {
        serverId: resolveServerProfileScopeIdForIdentifier(targetServerId),
        accountId: params.accountId,
    };
    const persisted = loadAccountSettings(scope);
    const persistedRecord = persisted.settings && typeof persisted.settings === 'object'
        ? persisted.settings as Record<string, unknown>
        : null;
    const hasPersistedRecord = persisted.version !== null
        || (persistedRecord !== null && Object.keys(persistedRecord).length > 0);
    if (!hasPersistedRecord) {
        return null;
    }
    const targetRequirement = resolveUiClientEncryptionRequirement({
        syncedSettings: persistedRecord ?? {},
        localSettings: persistedRecord ?? {},
    });
    return combineClientEncryptionRequirements(activeRequirement, targetRequirement);
}

export function assertScopedUiSessionEncryptionModeAllowed(params: Readonly<{
    mode: SessionEncryptionMode;
    serverId: string;
    accountId: string;
}>): void {
    if (params.mode !== 'plain') return;
    const requirement = resolveScopedClientEncryptionRequirement({
        serverId: params.serverId,
        accountId: params.accountId,
    });
    if (requirement === null) {
        throw Object.assign(
            new Error('This Happier client cannot confirm the target account allows plaintext sessions; refusing to issue plaintext.'),
            { code: 'CLIENT_ENCRYPTION_REQUIREMENT_UNAVAILABLE' },
        );
    }
    assertUiSessionEncryptionModeAllowed({ mode: params.mode, requirement });
}
