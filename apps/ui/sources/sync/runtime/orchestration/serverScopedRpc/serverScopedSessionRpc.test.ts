import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createServerFetchWithReachabilityProbe } from '@/dev/testkit';
import { sealBoundSessionRowFixture, sealSessionDataKeyFixture } from '@/dev/testkit/fixtures/sessionEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

import { sessionRpcWithServerScope } from './serverScopedSessionRpc';
import { resetScopedSessionDataKeyCacheForTests } from './resolveScopedSessionDataKey';

const sessionRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());

vi.mock('./createEphemeralServerSocketClient', () => ({ createEphemeralServerSocketClient: createEphemeralSocketSpy }));
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { sessionRPC: sessionRpcSpy } }));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
  TokenStorage: { getCredentialsForServerUrl: getCredentialsSpy },
}));

const sessionId = 'session-1';
let serverId: string;
let encryption: Encryption;
let envelope: string;
let boundMetadata: string;
const row = {
  id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
  archivedAt: null, metadataVersion: 1, agentState: null,
  agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
};

async function boundRow(dataKey: Uint8Array, sessionIdOverride = sessionId) {
  const bound = await sealBoundSessionRowFixture({ encryption, sessionId: sessionIdOverride, dataKey, metadata: { path: '/repo' } });
  return { ...row, id: sessionIdOverride, ...bound };
}

function respond(overrides: Record<string, unknown> = {}, status = 200) {
  vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
    ok: status === 200, status, json: async () => ({ session: {
      ...row, dataEncryptionKey: envelope, metadata: boundMetadata, ...overrides,
    } }),
  }))));
}

function socketFor(result: unknown) {
  const emitWithAck = vi.fn(async () => ({ ok: true, result }));
  const socket = { emitWithAck, timeout: vi.fn(() => ({ emitWithAck })), emit: vi.fn(), disconnect: vi.fn() };
  createEphemeralSocketSpy.mockResolvedValue(socket);
  return socket;
}

describe('sessionRpcWithServerScope', () => {
  beforeEach(async () => {
    const active = upsertServerProfile({ serverUrl: 'https://server-a.example.test' });
    setActiveServerId(active.id, { scope: 'device' });
    serverId = upsertServerProfile({ serverUrl: 'https://server-b.example.test' }).id;
    const secret = new Uint8Array(32).fill(7);
    encryption = await Encryption.create(secret);
    const dataKey = new Uint8Array(32).fill(9);
    envelope = sealSessionDataKeyFixture({ encryption, dataKey });
    boundMetadata = (await sealBoundSessionRowFixture({ encryption, sessionId, dataKey, metadata: { path: '/repo' } })).metadata;
    await encryption.initializeSessions(new Map([[sessionId, dataKey]]));
    getCredentialsSpy.mockResolvedValue({
      token: `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account' })), 'base64url')}.signature`,
      secret: encodeBase64(secret, 'base64url'),
    });
    // Scoped plaintext issuance requires a resolvable requirement for the target account's own scope.
    const previousSettingsScope = storage.getState().settingsScope ?? undefined;
    storage.getState().activateSettingsScope({ serverId, accountId: 'account' });
    storage.getState().applySettingsLocal({
      clientEncryptionRequirementV1: 'follow_account',
      clientEncryptionRequirementLocalV1: 'follow_account',
    });
    storage.getState().activateSettingsScope(previousSettingsScope ?? { serverId: active.id, accountId: 'account' });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetScopedSessionDataKeyCacheForTests();
    await resetServerReachabilitySupervisors();
  });

  it.each([5000, null])('keeps active RPC lifetime %s and issuance notification', async (timeoutMs) => {
    sessionRpcSpy.mockResolvedValue({ ok: true });
    const onIssued = vi.fn();
    await expect(sessionRpcWithServerScope({ sessionId, method: 'test', payload: { value: 1 }, timeoutMs, onIssued }))
      .resolves.toEqual({ ok: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith(sessionId, 'test', { value: 1 }, expect.objectContaining({ timeoutMs, onIssued: expect.any(Function) }));
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it.each(['encrypted', 'plain'] as const)('uses scoped %s RPC with real owner crypto', async (mode) => {
    respond(mode === 'plain' ? { encryptionMode: 'plain', dataEncryptionKey: null } : {});
    const peer = encryption.getSessionEncryption(sessionId)!;
    const reply = { decoded: true };
    const socket = socketFor(mode === 'plain' ? reply : await peer.encryptRaw(reply));
    const onIssued = vi.fn();
    await expect(sessionRpcWithServerScope({ sessionId, serverId, method: 'test', payload: { value: 2 }, timeoutMs: 5000, onIssued }))
      .resolves.toEqual(reply);
    const [event, request] = socket.emitWithAck.mock.calls[0] as unknown as [string, { method: string; params: string | object; timeoutMs: number }];
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    expect(request.method).toBe(`${sessionId}:test`);
    expect(request.timeoutMs).toBe(5000);
    expect(mode === 'plain' ? request.params : await peer.decryptRaw(request.params as string)).toEqual({ value: 2 });
    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(sessionRpcSpy).not.toHaveBeenCalled();
  });

  it.each(['missing', 'legacy', 'transplant', 'response-id', 'unknown'] as const)('rejects %s before scoped socket creation or issuance', async (kind) => {
    const legacy = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(9)), 'base64');
    const transplanted = kind === 'transplant'
      ? (await sealBoundSessionRowFixture({
        encryption, sessionId: 'other', dataKey: new Uint8Array(32).fill(9), metadata: { path: '/repo' },
      })).metadata
      : undefined;
    respond({
      id: kind === 'response-id' ? 'other' : sessionId,
      dataEncryptionKey: kind === 'missing' ? null : kind === 'legacy' ? legacy : envelope,
      ...(transplanted ? { metadata: transplanted } : {}),
      share: { accessLevel: 'admin', canApprovePermissions: true },
    }, kind === 'unknown' ? 500 : 200);
    const onIssued = vi.fn();
    const promise = sessionRpcWithServerScope({ sessionId, serverId, method: 'test', payload: { secret: 'never emitted' }, onIssued });
    if (kind === 'unknown') {
      await expect(promise).rejects.toMatchObject({ rpcErrorCode: 'scoped_session_encryption_unavailable' });
    } else {
      await expect(promise).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
    }
    expect(onIssued).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it.each(['missing-encryption', 'method-unavailable'] as const)('retries active %s through authenticated scoped transport', async (kind) => {
    const error = kind === 'missing-encryption' ? new Error('Session encryption not found')
      : Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    sessionRpcSpy.mockRejectedValueOnce(error);
    respond();
    socketFor(await encryption.getSessionEncryption(sessionId)!.encryptRaw({ recovered: true }));
    await expect(sessionRpcWithServerScope({ sessionId, method: 'test', payload: {} })).resolves.toEqual({ recovered: true });
  });

  it('does not retry an active RPC after exact issuance', async () => {
    sessionRpcSpy.mockImplementationOnce(async (_id, _method, _payload, options) => {
      options.onIssued();
      throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    });
    const onIssued = vi.fn();
    await expect(sessionRpcWithServerScope({ sessionId, method: 'test', payload: {}, onIssued })).rejects.toThrow('RPC method not available');
    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('keeps active pre-emission failures replayable', async () => {
    sessionRpcSpy.mockRejectedValueOnce(new Error('encryption failed before emit'));
    const onIssued = vi.fn();
    await expect(sessionRpcWithServerScope({ sessionId, method: 'test', payload: {}, onIssued })).rejects.toThrow('encryption failed before emit');
    expect(onIssued).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('bounds scoped setup but preserves explicit unbounded operation lifetime', async () => {
    respond({ encryptionMode: 'plain', dataEncryptionKey: null });
    const socket = socketFor({ watched: true });
    await expect(sessionRpcWithServerScope({ sessionId, serverId, method: 'watch', payload: {}, timeoutMs: null })).resolves.toEqual({ watched: true });
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    expect(socket.timeout).not.toHaveBeenCalled();
  });

  it('disconnects when a scoped ack does not settle before its timeout', async () => {
    respond({ encryptionMode: 'plain', dataEncryptionKey: null });
    const socket = socketFor(null);
    socket.emitWithAck.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const promise = sessionRpcWithServerScope({ sessionId, serverId, method: 'test', payload: {}, timeoutMs: 5 });
    const assertion = expect(promise).rejects.toThrow('operation has timed out');
    await vi.advanceTimersByTimeAsync(6);
    await assertion;
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
