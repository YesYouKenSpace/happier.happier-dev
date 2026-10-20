import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { EncryptionScopeInput } from '@/sync/encryption/encryption';
import { fetchAndApplySessionById, type SessionByIdEncryption } from '@/sync/engine/sessions/sessionById';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { storage } from '@/sync/domains/state/storage';
import { resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { resolveScopedClientEncryptionRequirement } from '@/sync/domains/settings/scopedClientEncryptionRequirement';

import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

function toScopedFetchCredentials(token: string): AuthCredentials {
    return { token, secret: '' };
}

function getScopedSessionByIdEncryption(context: Readonly<{
    decryptSessionEncryptionKey: (sessionId: string, value: string) => Promise<Uint8Array | null>;
    hasSessionEncryptionKey: (sessionId: string, dataKey: Uint8Array, scope?: EncryptionScopeInput) => boolean;
    removeSessionEncryption: (sessionId: string) => void;
    initializeSessions: (keys: Map<string, Uint8Array | null>, scope?: EncryptionScopeInput) => Promise<void>;
    getSessionEncryption: (sessionId: string) => unknown;
}>): SessionByIdEncryption {
    return {
        decryptSessionEncryptionKey: (sessionId, value) => context.decryptSessionEncryptionKey(sessionId, value),
        hasSessionEncryptionKey: (sessionId, key, scope) => context.hasSessionEncryptionKey(sessionId, key, scope),
        removeSessionEncryption: (sessionId) => context.removeSessionEncryption(sessionId),
        initializeSessions: (keys, scope) => context.initializeSessions(keys, scope),
        getSessionEncryption: (sessionId) => {
            const candidate = context.getSessionEncryption(sessionId);
            if (!candidate || typeof candidate !== 'object') {
                return null;
            }

            const maybeEncryption = candidate as Partial<{
                decryptAgentState: (version: number, value: string | null) => Promise<unknown>;
                decryptMetadata: (version: number, value: string) => Promise<unknown>;
            }>;
            if (typeof maybeEncryption.decryptAgentState !== 'function' || typeof maybeEncryption.decryptMetadata !== 'function') {
                return null;
            }

            return {
                decryptAgentState: maybeEncryption.decryptAgentState.bind(candidate),
                decryptMetadata: maybeEncryption.decryptMetadata.bind(candidate),
            };
        },
    };
}

export async function fetchSessionByIdWithServerScope(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    activeCredentials: AuthCredentials;
    activeEncryption?: SessionByIdEncryption | null;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
    activeRequest: (path: string, init: RequestInit) => Promise<Response>;
    applySessions: (sessions: AppliedSession[]) => void;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    log: { log: (message: string) => void };
    timeoutMs?: number;
    includeTurnsProjection?: boolean;
}>): Promise<Awaited<ReturnType<typeof fetchAndApplySessionById>>> {
    const currentSettings = storage.getState().settings;
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? null,
        timeoutMs: params.timeoutMs,
    });
    // The requirement gates plaintext rows; an unreadable target scope fails closed to e2ee-only.
    const clientEncryptionRequirement = context.scope === 'active'
        ? resolveUiClientEncryptionRequirement({
            syncedSettings: currentSettings,
            localSettings: currentSettings,
        })
        : (resolveScopedClientEncryptionRequirement({
            serverId: context.targetServerId,
            accountId: context.targetAccountId,
        }) ?? 'require_e2ee');

    if (context.scope === 'active') {
        if (!params.activeEncryption) {
            throw new Error(`Active session encryption is required to hydrate session ${params.sessionId}`);
        }
        return await fetchAndApplySessionById({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
            credentials: params.activeCredentials,
            encryption: params.activeEncryption,
            sessionDataKeys: params.sessionDataKeys,
            sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            request: params.activeRequest,
            applySessions: params.applySessions,
            getExistingSession: params.getExistingSession,
            log: params.log,
            timeoutMs: params.timeoutMs,
            includeTurnsProjection: params.includeTurnsProjection,
            clientEncryptionRequirement,
        });
    }

    return await fetchAndApplySessionById({
        sessionId: params.sessionId,
        serverId: context.targetServerId,
        credentials: toScopedFetchCredentials(context.token),
        encryption: getScopedSessionByIdEncryption(context.encryption),
        sessionDataKeys: params.sessionDataKeys,
        sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
        request: async (path: string, init: RequestInit) => {
            return await runtimeFetchWithServerReachability({
                serverUrl: context.targetServerUrl,
                token: context.token,
                url: `${context.targetServerUrl}${path}`,
                init: {
                    ...init,
                    headers: {
                        ...(init.headers ?? {}),
                        Authorization: `Bearer ${context.token}`,
                    },
                },
            });
        },
        applySessions: params.applySessions,
        getExistingSession: params.getExistingSession,
        log: params.log,
        timeoutMs: params.timeoutMs,
        includeTurnsProjection: params.includeTurnsProjection,
        clientEncryptionRequirement,
    });
}
