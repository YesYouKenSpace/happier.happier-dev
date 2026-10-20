import { afterEach, describe, expect, it, vi } from 'vitest';

import { sealSessionDataKeyFixture, sealBoundSessionRowFixture } from '@/dev/testkit/fixtures/sessionEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

import { resetScopedSessionDataKeyCacheForTests, resolveScopedSessionDataKey } from './resolveScopedSessionDataKey';
import { resolveScopedPendingSessionEncryption } from './resolveScopedPendingSessionEncryption';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args) }));

const row = {
  id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
  archivedAt: null, metadata: 'metadata', metadataVersion: 1, agentState: null,
  agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
};

async function boundRow(encryption: Encryption, dataKey: Uint8Array, sessionId = row.id) {
  const bound = await sealBoundSessionRowFixture({ encryption, sessionId, dataKey, metadata: { path: '/repo' } });
  return { ...row, id: sessionId, ...bound };
}

function respond(body: unknown, status = 200) {
  runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (/\/(health|v1\/auth\/ping)$/.test(String(input))) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(body), { status });
  });
}

describe('scoped session key authentication', () => {
  afterEach(async () => {
    runtimeFetchMock.mockReset();
    resetScopedSessionDataKeyCacheForTests();
    await resetServerReachabilitySupervisors();
  });

  it.each(['authenticated', 'legacy', 'missing', 'transplant', 'response-id', 'unavailable'] as const)(
    'requires authenticated context before scoped pending authoring: %s', async (kind) => {
      const encryption = await Encryption.create(new Uint8Array(32).fill(7));
      const dataKey = new Uint8Array(32).fill(9);
      const envelope = kind === 'legacy'
        ? encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64')
        : kind === 'missing' ? null : sealSessionDataKeyFixture({ encryption, dataKey });
      // A transplanted row carries another session's ID binding inside valid ciphertext.
      const bound = kind === 'authenticated' || kind === 'transplant'
        ? await sealBoundSessionRowFixture({
          encryption, dataKey,
          sessionId: kind === 'transplant' ? 'other' : row.id,
          metadata: { path: '/repo' },
        })
        : null;
      respond({ session: {
        ...row,
        id: kind === 'response-id' ? 'other' : row.id,
        ...(bound ? { dataEncryptionKey: bound.dataEncryptionKey, metadata: bound.metadata } : { dataEncryptionKey: envelope }),
      } }, kind === 'unavailable' ? 500 : 200);
      const context = {
        scope: 'scoped' as const, targetServerId: 'server', targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account', token: 'synthetic-token', timeoutMs: 1000, encryption,
      };
      const pending = resolveScopedPendingSessionEncryption({ context, sessionId: row.id });
      if (kind === 'authenticated') {
        const session = await pending;
        const message = { role: 'user' as const, content: { type: 'text' as const, text: 'trusted input' } };
        expect(await session.decryptRaw(await session.encryptRawRecord(message))).toEqual(message);
      } else if (kind === 'unavailable') {
        await expect(pending).rejects.toThrow('Session encryption unavailable');
        expect(encryption.getSessionEncryption(row.id)).toBeNull();
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
        expect(encryption.getSessionEncryption(row.id)).toBeNull();
      }
    },
  );

  it('does not reuse a cached key after envelope replacement or secret rotation with the same token', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const dataKey = new Uint8Array(32).fill(9);
    const bound = await sealBoundSessionRowFixture({ encryption, dataKey, sessionId: row.id, metadata: { path: '/repo' } });
    respond({ session: { ...row, ...bound } });
    const params = {
      serverId: 'server', serverUrl: 'https://server.example.test', token: 'token', sessionId: row.id,
      encryption,
    };
    await expect(resolveScopedSessionDataKey(params)).resolves.toEqual(dataKey);
    const other = await Encryption.create(new Uint8Array(32).fill(8));
    await expect(resolveScopedSessionDataKey({ ...params, encryption: other })).rejects.toMatchObject({
      code: 'SESSION_KEY_AUTHENTICATION_FAILED',
    });
    respond({ session: { ...row, dataEncryptionKey: null } });
    await expect(resolveScopedSessionDataKey(params)).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED' });
  });

  it('preserves terminal HTTP authentication failures', async () => {
    respond({}, 401);
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    await expect(resolveScopedSessionDataKey({
      serverId: 'server', serverUrl: 'https://server.example.test', token: 'token', sessionId: row.id,
      encryption,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
  });
});
