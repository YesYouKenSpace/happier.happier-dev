import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createServerFetchWithReachabilityProbe } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { Encryption } from '@/sync/encryption/encryption';
import { enqueuePendingMessageV2, retryPendingOutboxOperationV2, updatePendingMessageV2 } from '@/sync/engine/pending/pendingQueueV2';
import { buildSession } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { sessionEphemeralTaskRun } from '@/sync/ops/sessionEphemeralTasks';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

const createSocket = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: createSocket,
}));

const initialState = storage.getState();
const sessionId = 'requirement-owner';
const localId = 'requirement-message';
const payload = { content: 'synthetic-sensitive-content' };
let targetServerId: string;
let activeServerId: string;
let encryption: Encryption;
const emitWithAck = vi.fn(async (_event: string, _payload: unknown): Promise<unknown> => ({ ok: true, result: { ok: true } }));
const socket = { emitWithAck, timeout: () => ({ emitWithAck }), disconnect: vi.fn() };
const apiInternals = apiSocket as unknown as { socket: typeof socket | null; encryption: Encryption | null };

function setRequirement(requirement: 'follow_account' | 'require_e2ee') {
    storage.getState().applySettingsLocal({
        clientEncryptionRequirementV1: 'follow_account',
        clientEncryptionRequirementLocalV1: requirement,
    });
    const settings = storage.getState().settings;
    expect(resolveUiClientEncryptionRequirement({ syncedSettings: settings, localSettings: settings })).toBe(requirement);
}

describe('session write encryption requirement', () => {
    beforeEach(async () => {
        storage.setState(initialState, true);
        vi.stubGlobal('window', { localStorage: globalThis.localStorage });
        emitWithAck.mockReset();
        emitWithAck.mockResolvedValue({ ok: true, result: { ok: true } });
        createSocket.mockReset();
        createSocket.mockResolvedValue(socket);
        const secret = new Uint8Array(32).fill(7);
        encryption = await Encryption.create(secret);
        const credentials = {
            token: `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'synthetic-account' })), 'base64url')}.signature`,
            secret: encodeBase64(secret, 'base64url'),
        };
        const active = upsertServerProfile({ serverUrl: 'https://requirement-active.example.test' });
        const target = upsertServerProfile({ serverUrl: 'https://requirement-scoped.example.test' });
        activeServerId = active.id;
        targetServerId = target.id;
        for (const profile of [target, active]) {
            setActiveServerId(profile.id, { scope: 'device' });
            expect(await TokenStorage.setCredentials(credentials)).toBe(true);
            expect(await TokenStorage.getCredentials()).toEqual(credentials);
            storage.getState().activateSettingsScope({ serverId: profile.id, accountId: 'synthetic-account' });
            setRequirement('follow_account');
        }
        apiInternals.socket = socket;
        apiInternals.encryption = encryption;
        storage.getState().applySessions([buildSession({
            sessionId, overrides: { encryptionMode: 'plain', metadata: { path: '/repo', host: 'synthetic' }, metadataVersion: 1 },
        })]);
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => Response.json({ session: {
            id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null, agentStateVersion: 0,
            pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
        } }))));
    });

    afterEach(async () => {
        const { sync } = await import('./sync');
        sync.disconnectServer();
        sync.setMessageTransport(apiSocket);
        apiInternals.socket = null;
        apiInternals.encryption = null;
        vi.unstubAllGlobals();
        vi.useRealTimers();
        await resetServerReachabilitySupervisors();
        storage.setState(initialState, true);
    });

    it.each(['active', 'scoped', 'active-fallback', 'ephemeral'] as const)(
        '%s RPC honors the real local floor and permits explicit opt-out', async (entry) => {
            if (entry === 'active-fallback') {
                storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'e2ee' } })]);
                await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(9)]]));
            }
            for (const requirement of ['follow_account', 'require_e2ee'] as const) {
                setRequirement(requirement);
                emitWithAck.mockClear();
                createSocket.mockClear();
                if (entry === 'active-fallback') {
                    emitWithAck.mockResolvedValueOnce({ ok: false, error: 'Unavailable', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
                }
                const operation = entry === 'active' ? apiSocket.sessionRPC(sessionId, 'write', payload)
                    : entry === 'ephemeral' ? sessionEphemeralTaskRun(sessionId, {
                        kind: 'scm.commit_message', sessionId, input: { backendId: 'claude' }, permissionMode: 'no_tools',
                    }, { serverId: targetServerId })
                    : sessionRpcWithServerScope({ sessionId, method: 'write', payload, serverId: entry === 'scoped' ? targetServerId : undefined });
                const outcome = await operation.then((result) => ({ result }), (error: unknown) => ({ error }));
                const rawCalls = emitWithAck.mock.calls.filter(([, value]) => {
                    const params = (value as { params?: unknown }).params;
                    return typeof params !== 'string';
                });
                if (requirement === 'require_e2ee') {
                    expect.soft(rawCalls).toEqual([]);
                    expect.soft(emitWithAck).toHaveBeenCalledTimes(entry === 'active-fallback' ? 1 : 0);
                    if (entry === 'active-fallback') {
                        const issued = emitWithAck.mock.calls[0]?.[1] as { params: string };
                        expect(await encryption.getSessionEncryption(sessionId)!.decryptRaw(issued.params)).toEqual(payload);
                    }
                    expect(outcome).toMatchObject(entry === 'ephemeral'
                        ? { result: { ok: false, errorCode: 'CLIENT_E2EE_REQUIRED' } }
                        : { error: { code: 'CLIENT_E2EE_REQUIRED' } });
                } else {
                    expect(outcome).toMatchObject({ result: { ok: true } });
                    expect(rawCalls).toHaveLength(1);
                }
            }
        },
    );

    it.each(['enqueue', 'edit', 'retry', 'reenqueue'] as const)(
        'pending %s refuses plaintext without emitting or deleting existing outbox data', async (entry) => {
            const outboxScope = { serverId: activeServerId, accountId: 'synthetic-account' };
            const request = vi.fn(async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' }, pending: { localId } }));
            const params = { sessionId, localId, text: 'sensitive pending input', encryption, request, outboxScope,
                wireMode: 'pending_input_v2' as const, requestedAction: { v: 1 as const, kind: 'enqueue' as const } };
            setRequirement('follow_account');
            if (entry !== 'enqueue') {
                await enqueuePendingMessageV2({ ...params, wireMode: 'indeterminate' });
            }
            if (entry === 'retry' || entry === 'reenqueue') {
                storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'e2ee' } })]);
            }
            const saved = await loadPendingOutboxForSession(sessionId, outboxScope);
            for (const requirement of ['require_e2ee', 'follow_account'] as const) {
                setRequirement(requirement);
                request.mockClear();
                const operation = entry === 'edit' ? updatePendingMessageV2({ ...params, pendingId: localId })
                    : entry === 'retry' ? retryPendingOutboxOperationV2(params) : enqueuePendingMessageV2(params);
                const outcome = await operation.then((result) => ({ result }), (error: unknown) => ({ error }));
                if (requirement === 'require_e2ee') {
                    expect.soft(request).not.toHaveBeenCalled();
                    expect.soft(await loadPendingOutboxForSession(sessionId, outboxScope)).toEqual(saved);
                    expect(outcome).toMatchObject({ error: { code: 'CLIENT_E2EE_REQUIRED' } });
                } else {
                    expect(outcome).toHaveProperty('result');
                    expect(request).toHaveBeenCalledTimes(1);
                }
            }
        },
    );

    it('rechecks the floor when scoped socket setup yields before plaintext issuance', async () => {
        setRequirement('follow_account');
        createSocket.mockImplementationOnce(async () => {
            setRequirement('require_e2ee');
            return socket;
        });
        const outcome = await sessionRpcWithServerScope({ sessionId, serverId: targetServerId, method: 'write', payload })
            .then((result) => ({ result }), (error: unknown) => ({ error }));
        expect.soft(emitWithAck).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ error: { code: 'CLIENT_E2EE_REQUIRED' } });
    });

    it.each(['pin', 'synced', 'late-pin', 'unavailable', 'other-account'] as const)(
        'uses the target account settings, not active opt-out: %s', async (kind) => {
            const targetScope = { serverId: targetServerId, accountId: 'synthetic-account' };
            const activeScope = { serverId: activeServerId, accountId: 'synthetic-account' };
            const unknownTarget = upsertServerProfile({ serverUrl: 'https://requirement-unknown.example.test' });
            if (kind === 'unavailable') {
                const credentials = await TokenStorage.getCredentials();
                expect(credentials).not.toBeNull();
                setActiveServerId(unknownTarget.id, { scope: 'device' });
                await TokenStorage.setCredentials(credentials!);
                setActiveServerId(activeServerId, { scope: 'device' });
            } else if (kind !== 'late-pin') {
                storage.getState().activateSettingsScope(kind === 'other-account'
                    ? { ...targetScope, accountId: 'another-account' } : targetScope);
                storage.getState().applySettingsLocal({
                    clientEncryptionRequirementV1: kind === 'synced' ? 'require_e2ee' : 'follow_account',
                    clientEncryptionRequirementLocalV1: kind === 'synced' ? 'follow_account' : 'require_e2ee',
                });
            }
            storage.getState().activateSettingsScope(activeScope);
            setRequirement('follow_account');
            if (kind === 'pin') {
                expect(loadAccountSettings(targetScope).settings).toMatchObject({ clientEncryptionRequirementLocalV1: 'require_e2ee' });
            }
            if (kind === 'late-pin') {
                createSocket.mockImplementationOnce(async () => {
                    storage.getState().replaceSettingsForScope(targetScope, {
                        ...settingsDefaults, clientEncryptionRequirementLocalV1: 'require_e2ee',
                    }, 1);
                    expect(storage.getState().settingsScope).toEqual(activeScope);
                    expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('follow_account');
                    return socket;
                });
            }
            const outcome = await sessionRpcWithServerScope({
                sessionId, serverId: kind === 'unavailable' ? unknownTarget.id : targetServerId, method: 'write', payload,
            }).then((result) => ({ result }), (error: unknown) => ({ error }));
            if (kind === 'other-account') {
                expect(outcome).toMatchObject({ result: { ok: true } });
                expect(emitWithAck).toHaveBeenCalledTimes(1);
            } else {
                expect.soft(emitWithAck).not.toHaveBeenCalled();
                expect(outcome).toMatchObject({ error: { code: kind === 'unavailable'
                    ? 'CLIENT_ENCRYPTION_REQUIREMENT_UNAVAILABLE' : 'CLIENT_E2EE_REQUIRED' } });
            }
        },
    );

    it.each(['metadata', 'pending'] as const)('target pin also guards scoped %s writes', async (entry) => {
        const targetScope = { serverId: targetServerId, accountId: 'synthetic-account' };
        storage.getState().activateSettingsScope(targetScope);
        setRequirement('require_e2ee');
        storage.getState().activateSettingsScope({ serverId: activeServerId, accountId: 'synthetic-account' });
        setRequirement('follow_account');
        const request = vi.fn(async () => Response.json({ pending: { localId }, requestedAction: { v: 1, kind: 'enqueue' } }));
        if (entry === 'metadata') {
            emitWithAck.mockImplementation(async (_event, value) => ({ result: 'success', version: 2, metadata: (value as { metadata: string }).metadata }));
        }
        const { sync } = await import('./sync');
        const outcome = await (entry === 'metadata'
            ? sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({ ...metadata, name: 'private name' }), { serverId: targetServerId })
            : enqueuePendingMessageV2({
                sessionId, localId, text: 'private pending input', encryption, request, outboxScope: targetScope,
                wireMode: 'pending_input_v2', requestedAction: { v: 1, kind: 'enqueue' },
            })).then((result) => ({ result }), (error: unknown) => ({ error }));
        expect.soft(emitWithAck).not.toHaveBeenCalled();
        expect.soft(request).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ error: { code: 'CLIENT_E2EE_REQUIRED' } });
    });

    it('rechecks direct-message policy after send preflight yields', async () => {
        const { sync } = await import('./sync');
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', active: false } })]);
        sync.setMessageTransport(apiSocket);
        setRequirement('follow_account');
        const operation = sync.sendMessage(sessionId, 'sensitive direct message');
        setRequirement('require_e2ee');
        const outcome = await operation
            .then((result) => ({ result }), (error: unknown) => ({ error }));
        expect.soft(emitWithAck).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ error: { code: 'CLIENT_E2EE_REQUIRED' } });
    });

    it('stops a scheduled plaintext message retry after the local floor is raised', async () => {
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            schedulePendingMessageCommitRetry: (params: { sessionId: string; localId: string }) => void;
            pendingMessageCommitRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
        };
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, source: 'local_outbound', createdAt: 1, updatedAt: 1, text: 'unsent',
            rawRecord: { role: 'user', content: { type: 'text', text: 'unsent' } },
        });
        sync.setMessageTransport(apiSocket);
        setRequirement('follow_account');
        vi.useFakeTimers();
        try {
            internals.schedulePendingMessageCommitRetry({ sessionId, localId });
            setRequirement('require_e2ee');
            await vi.advanceTimersByTimeAsync(1000);
            expect.soft(emitWithAck).not.toHaveBeenCalled();
            expect(internals.pendingMessageCommitRetryTimers.has(`${sessionId}:${localId}`)).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([expect.objectContaining({ text: 'unsent' })]);
        } finally {
            for (const timer of internals.pendingMessageCommitRetryTimers.values()) clearTimeout(timer);
            internals.pendingMessageCommitRetryTimers.clear();
            sync.setMessageTransport(apiSocket);
        }
    });

    it.each(['active', 'scoped-late-pin'] as const)('metadata %s checks the local floor before socket issuance', async (entry) => {
        const { sync } = await import('./sync');
        const updater = sync as unknown as {
            encryption: Encryption;
            updateSessionMetadataWithRetry: (id: string, update: (metadata: Metadata) => Metadata, options?: { serverId: string }) => Promise<void>;
        };
        updater.encryption = encryption;
        emitWithAck.mockImplementation(async (_event, value) => ({ result: 'success', version: 2, metadata: (value as { metadata: string }).metadata }));
        for (const requirement of ['require_e2ee', 'follow_account'] as const) {
            setRequirement(requirement);
            emitWithAck.mockClear();
            if (entry === 'scoped-late-pin' && requirement === 'require_e2ee') {
                setRequirement('follow_account');
                createSocket.mockImplementationOnce(async () => { setRequirement('require_e2ee'); return socket; });
            }
            const operation = updater.updateSessionMetadataWithRetry(
                sessionId, (metadata) => ({ ...metadata, name: 'sensitive name' }), entry === 'scoped-late-pin' ? { serverId: targetServerId } : undefined,
            );
            const outcome = await operation.then(() => ({ ok: true }), (error: unknown) => ({ error }));
            if (requirement === 'require_e2ee') {
                expect.soft(emitWithAck).not.toHaveBeenCalled();
                expect(outcome).toMatchObject({ error: { code: 'CLIENT_E2EE_REQUIRED' } });
            } else {
                expect(outcome).toEqual({ ok: true });
                expect(emitWithAck).toHaveBeenCalledTimes(1);
            }
        }
    });
});
