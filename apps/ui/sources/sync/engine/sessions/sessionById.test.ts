import { describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById } from './sessionById';
import { Encryption } from '@/sync/encryption/encryption';
import { sealSessionDataKeyFixture, withSessionKeyBindingForTests } from '@/dev/testkit/fixtures/sessionEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';

const onAgentRequest = vi.fn();

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onAgentRequest: (...args: Parameters<typeof onAgentRequest>) => onAgentRequest(...args),
  },
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fetchAndApplySessionById', () => {
  it.each(['authenticated', 'legacy-owner', 'legacy-share', 'missing', 'transplant', 'response-id'] as const)(
    'authenticates %s at the requested HTTP session boundary', async (kind) => {
      const encryption = await Encryption.create(new Uint8Array(32).fill(7));
      const dataKey = new Uint8Array(32).fill(9);
      const sessionId = 'authenticated-owner';
      const envelope = kind.startsWith('legacy')
        ? encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64')
        : kind === 'missing' ? null : sealSessionDataKeyFixture({ encryption, dataKey });
      await encryption.initializeSessions(new Map([[sessionId, dataKey]]));
      // A transplanted row carries another session's ID binding inside otherwise valid ciphertext.
      const metadata = await encryption.getSessionEncryption(sessionId)!.encryptRaw(
        withSessionKeyBindingForTests({ path: '/trusted' }, {
          sessionId: kind === 'transplant' ? 'different-session' : sessionId,
        }),
      );
      const sessionDataKeys = new Map([[sessionId, dataKey]]);
      const sessionDataKeyEnvelopes = new Map([[sessionId, 'replaced-envelope']]);
      const applySessions = vi.fn();
      const request = vi.fn(async () => new Response(JSON.stringify({ session: {
        id: kind === 'response-id' ? 'different-session' : sessionId,
        seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: envelope,
        share: kind === 'legacy-share' ? { accessLevel: 'admin', canApprovePermissions: true } : null,
      } }), { status: 200 }));
      const result = await fetchAndApplySessionById({
        sessionId, encryption, sessionDataKeys, sessionDataKeyEnvelopes, request, applySessions,
        credentials: { token: 'synthetic-token', secret: '' }, log: { log: () => {} },
        includeTurnsProjection: false, clientEncryptionRequirement: 'require_e2ee',
      });
      if (kind === 'authenticated') {
        expect(result.ok).toBe(true);
        expect(result.session?.metadata?.path).toBe('/trusted');
        expect(sessionDataKeys.get(sessionId)).toEqual(dataKey);
      } else {
        expect(result).toMatchObject({ ok: false, session: null, errorCode: 'SESSION_KEY_AUTHENTICATION_FAILED' });
        expect(sessionDataKeys.size).toBe(0);
        expect(sessionDataKeyEnvelopes.size).toBe(0);
        expect(encryption.getSessionEncryption(sessionId)).toBeNull();
        expect(applySessions).not.toHaveBeenCalled();
      }
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a plaintext session before parsing or applying it when this client requires E2EE', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_plain_blocked',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ path: '/must-not-open' }),
        agentStateVersion: 1,
        agentState: null,
        share: null,
      },
    }), { status: 200 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_plain_blocked',
      credentials: { token: 'token', secret: 'secret' },
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      clientEncryptionRequirement: 'require_e2ee',
    });

    expect(result).toEqual({ ok: false, session: null, errorCode: 'client_e2ee_required' });
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('uses browser-CORS-safe headers for targeted session detail reads', async () => {
    const applySessions = vi.fn();
    const requestInits: RequestInit[] = [];
    const request = async (_path: string, init: RequestInit) => {
      requestInits.push(init);
      return new Response(JSON.stringify({
        session: {
          id: 's_targeted_hydration',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 1,
          metadata: JSON.stringify({ readStateV1: null }),
          agentStateVersion: 1,
          agentState: JSON.stringify({ controlledByUser: false }),
          share: null,
        },
      }), { status: 200 });
    };

    const result = await fetchAndApplySessionById({
      sessionId: 's_targeted_hydration',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 'token', secret: 'secret' },
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    const headers = requestInits[0]?.headers as Record<string, string> | undefined;
    expect(headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    }));
    expect(headers).not.toHaveProperty('X-Happier-Request-Purpose');
  });

  it('accepts legacy-compatible single-session payloads when newer fields are omitted', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_legacy_payload',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        accessLevel: 'admin',
        canApprovePermissions: true,
      },
    }), { status: 200 }));

    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_payload',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_legacy_payload',
        accessLevel: 'admin',
        canApprovePermissions: true,
      }),
    ]);
    expect(encryption.getSessionEncryption('s_legacy_payload')).toBeNull();
  });

  it('falls back to scanning /v2/sessions when the single-session route is missing', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_legacy') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy',
          method: 'GET',
        }), { status: 404 });
      }

      if (path === '/v1/sessions/s_legacy/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [
          {
            id: 's_legacy',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        ],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_legacy',
        encryptionMode: 'plain',
      }),
    ]);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_legacy',
      '/v2/sessions?limit=200',
      '/v1/sessions/s_legacy/turns',
    ]);
  });

  it('returns not_found for the current-server session-by-id 404 contract without compat scanning', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (_path: string) => new Response(JSON.stringify({
      error: 'Session not found',
    }), { status: 404 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_missing',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'not_found',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_missing',
    ]);
  });

  it.each([401, 403] as const)('throws terminal auth for session-by-id status %s', async (status) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'auth failed' }), { status }));

    await expect(fetchAndApplySessionById({
      sessionId: 's_auth_failed',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(applySessions).not.toHaveBeenCalled();
  });

  it('announces new fetched agent requests relative to existing session state', async () => {
    onAgentRequest.mockReset();
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: 'unused-plain-key',
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      getExistingSession: () => ({
        id: 's1',
        agentState: {
          controlledByUser: true,
          requests: {},
          completedRequests: {},
        },
      } as any),
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      's1',
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
  });

  it('captures the previous session before applySessions updates storage', async () => {
    onAgentRequest.mockReset();

    let storedSession = {
      id: 's1',
      agentState: {
        controlledByUser: true,
        requests: {},
        completedRequests: {},
      },
    } as any;

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: ([nextSession]) => {
        storedSession = nextSession as any;
      },
      getExistingSession: () => storedSession,
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      's1',
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
  });

  it('applies a plaintext session row by id', async () => {
    onAgentRequest.mockReset();
    const applySessions = vi.fn();
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));

    const responseJson = {
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
        share: null,
      },
    };

    const request = vi.fn(async () => new Response(JSON.stringify(responseJson), { status: 200 }));
    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption,
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(request).toHaveBeenCalledWith('/v2/sessions/s1', expect.any(Object));
    expect(encryption.getSessionEncryption('s1')).toBeNull();
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        encryptionMode: 'plain',
        metadata: expect.any(Object),
        agentState: expect.any(Object),
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
      }),
    ]);
  });

  it('hydrates session turn projection for rollback read models', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s1') {
        return new Response(JSON.stringify({
          session: {
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      expect(path).toBe('/v1/sessions/s1/turns');
      return new Response(JSON.stringify({
        v: 1,
        sessionId: 's1',
        latestTurnId: 'turn-1',
        updatedAt: 4,
        turns: [
          {
            turnId: 'turn-1',
            status: 'completed',
            startedAt: 1,
            updatedAt: 4,
            terminalAt: 4,
            transcriptAnchors: {
              startUserMessageSeq: 1,
              userMessageSeqs: [1, 3],
              startSeqInclusive: 1,
              endSeqInclusive: 4,
            },
            rollback: { state: 'eligible', updatedAt: 4 },
          },
        ],
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s1',
      '/v1/sessions/s1/turns',
    ]);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        sessionTurns: expect.objectContaining({
          latestTurnId: 'turn-1',
          turns: [expect.objectContaining({ turnId: 'turn-1' })],
        }),
        rollbackEligibleTurnStarts: [1],
      }),
    ]);
  });

  it('keeps mixed-version session-by-id hydration working when the turns route is missing', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s1') {
        return new Response(JSON.stringify({
          session: {
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      expect(path).toBe('/v1/sessions/s1/turns');
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s1',
      '/v1/sessions/s1/turns',
    ]);
    expect(applySessions).toHaveBeenCalledWith([
      expect.not.objectContaining({
        sessionTurns: expect.anything(),
      }),
    ]);
  });

  it('stores the owning serverId on hydrated sessions when fetch scope is known', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      serverId: 'server-owned',
      credentials: { token: 't' } as any,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        serverId: 'server-owned',
      }),
    ]);
  });

  it('initializes session encryption when dataEncryptionKey is present', async () => {
    onAgentRequest.mockReset();
    const applySessions = vi.fn();
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const dataKey = new Uint8Array(32).fill(9);
    const envelope = sealSessionDataKeyFixture({ encryption, dataKey });
    const writer = await encryption.openEncryption(dataKey);
    const [metadata, agentState] = (await writer.encrypt([
      withSessionKeyBindingForTests({ path: '/repo' }, { sessionId: 's1' }),
      { controlledByUser: true },
    ]))
      .map((bytes) => encodeBase64(bytes, 'base64'));

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: envelope,
        metadataVersion: 1,
        metadata,
        agentStateVersion: 1,
        agentState,
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(sessionDataKeys.get('s1')).toEqual(dataKey);
    expect(applySessions).toHaveBeenCalledWith([expect.objectContaining({
      metadata: expect.objectContaining({ path: '/repo' }), agentState: { controlledByUser: true },
    })]);
  });

  it('reuses a cached session data key when the encrypted envelope is unchanged', async () => {
    const applySessions = vi.fn();
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const cachedKey = new Uint8Array(32).fill(9);
    const envelope = sealSessionDataKeyFixture({ encryption, dataKey: cachedKey });
    await encryption.initializeSessions(new Map([['s_cached', cachedKey]]));
    const sessionEncryption = encryption.getSessionEncryption('s_cached')!;
    const metadata = await sessionEncryption.encryptRaw(
      withSessionKeyBindingForTests({ path: '/repo' }, { sessionId: 's_cached' }),
    );
    const agentState = await sessionEncryption.encryptRaw({ controlledByUser: true });

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_cached',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: envelope,
        metadataVersion: 1,
        metadata,
        agentStateVersion: 1,
        agentState,
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>([['s_cached', cachedKey]]);
    const sessionDataKeyEnvelopes = new Map<string, string>([['s_cached', envelope]]);

    await fetchAndApplySessionById({
      sessionId: 's_cached',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys,
      sessionDataKeyEnvelopes,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(encryption.getSessionEncryption('s_cached')).toBe(sessionEncryption);
    expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
    expect(sessionDataKeyEnvelopes.get('s_cached')).toBe(envelope);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_cached',
        metadata: expect.objectContaining({ path: '/repo' }),
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('starts encrypted metadata and agent-state decrypts before awaiting either result', async () => {
    const applySessions = vi.fn();
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const dataKey = new Uint8Array(32).fill(9);
    const envelope = sealSessionDataKeyFixture({ encryption, dataKey });
    const writer = await encryption.openEncryption(dataKey);
    const [metadata, agentState] = (await writer.encrypt([
      withSessionKeyBindingForTests({ path: '/repo' }, { sessionId: 's_parallel' }),
      { controlledByUser: true },
    ]))
      .map((bytes) => encodeBase64(bytes, 'base64'));
    const worker = createFakeCryptoWorker();
    const gate = createDeferred<void>();
    const decryptAesGcmJson = vi.fn(async (request: Parameters<typeof worker.decryptAesGcmJson>[0]) => {
      await gate.promise;
      return worker.decryptAesGcmJson(request);
    });
    encryption.configureNativeCryptoWorker({
      worker: { ...worker, decryptAesGcmJson },
      routing: { mode: 'require', minPayloadBytes: 0, minBatchSize: 1 },
    });

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_parallel',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: envelope,
        metadataVersion: 1,
        metadata,
        agentStateVersion: 1,
        agentState,
        share: null,
      },
    }), { status: 200 }));

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_parallel',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    try {
      await expect.poll(() => decryptAesGcmJson.mock.calls.flatMap(([request]) => request.items).length).toBe(2);
    } finally {
      gate.resolve();
      await fetchPromise;
    }

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_parallel',
        metadata: expect.objectContaining({ path: '/repo' }),
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('coalesces concurrent session detail HTTP reads for the same request transport', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_coalesced',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const baseParams = {
      sessionId: 's_coalesced',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      log: { log: () => {} },
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const first = fetchAndApplySessionById({ ...baseParams, applySessions: firstApplySessions });
    const second = fetchAndApplySessionById({ ...baseParams, applySessions: secondApplySessions });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(request.mock.calls.filter((call) => call[0] === '/v2/sessions/s_coalesced')).toHaveLength(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
  });

  it('coalesces concurrent scoped session detail HTTP reads across request wrappers', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const createRequest = () => vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_scoped_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_scoped_coalesced',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_scoped_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const baseParams = {
      sessionId: 's_scoped_coalesced',
      clientEncryptionRequirement: 'follow_account' as const,
      serverId: 'server-a',
      credentials: { token: 't', secret: 's' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      log: { log: () => {} },
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const firstRequest = createRequest();
    const secondRequest = createRequest();
    const first = fetchAndApplySessionById({
      ...baseParams,
      request: firstRequest,
      applySessions: firstApplySessions,
    });
    const second = fetchAndApplySessionById({
      ...baseParams,
      request: secondRequest,
      applySessions: secondApplySessions,
    });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(detailRequests).toBe(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
  });

  it('can hydrate the session shell without fetching the turns projection', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_shell_only') {
        return new Response(JSON.stringify({
          session: {
            id: 's_shell_only',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_shell_only/turns') {
        throw new Error('turns projection should not be fetched for shell-only hydration');
      }

      throw new Error(`unexpected path ${path}`);
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_shell_only',
      clientEncryptionRequirement: 'follow_account' as const,
      credentials: { token: 't', secret: 's' },
      encryption: await Encryption.create(new Uint8Array(32).fill(7)),
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: vi.fn(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual(['/v2/sessions/s_shell_only']);
  });
});
