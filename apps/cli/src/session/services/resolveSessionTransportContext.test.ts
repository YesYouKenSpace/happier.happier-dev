import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountSettingsParse,
  buildSessionKeyBindingMetadataField,
  sealEncryptedDataKeyEnvelopeV1,
  sealOwnerSessionDataKeyEnvelope,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { encodeBase64, encrypt, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createEncryptedSessionRecordFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';
import { getMemoryWindow } from '@/daemon/memory/getMemoryWindow';
import { hydrateReplayDialogFromTranscript } from '@/session/replay/hydrateReplayDialogFromTranscript';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { commitConnectedServiceRuntimeAuthRecoverySessionEvent } from '@/daemon/connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';
import { commitConnectedServiceQuotaLifecycleSessionEvents } from '@/daemon/connectedServices/quotas/commitConnectedServiceQuotaLifecycleSessionEvents';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { listSessions } from './listSessions';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { buildResumeSelectionModel } from '@/cli/commands/resumeInteractiveSelection';
import { buildAttachSelectionModel } from '@/cli/commands/attachInteractiveSelection';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';

describe('strict session transport', () => {
  const id = 'session-owner-target';
  const machineKey = randomBytes(32);
  const publicKey = libsodiumPublicKeyFromSecretKey(machineKey);
  const credentials: Credentials = { token: 'synthetic-token', encryption: { type: 'dataKey', machineKey, publicKey } };
  const key = new Uint8Array(randomBytes(32));
  const sealed = () => encodeBase64(sealOwnerSessionDataKeyEnvelope({
    material: credentials.encryption, sessionTag: 'tag', dataKey: key, randomBytes,
  }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['prefix', 'tag', 'list', 'resume', 'attach', 'selected-legacy', 'legacy-tag', 'policy-refused-list', 'selected-plain'] as const)(
    '%s isolates an inaccessible row without trusting its metadata', async (surface) => {
      vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
      const metadata = { tag: 'verified-tag', summary: { text: 'Verified owner' }, path: '/verified', flavor: 'claude', claudeSessionId: 'vendor-verified', host: 'synthetic-host', terminal: { mode: 'tmux', target: 'verified:0' } };
      const valid = createEncryptedSessionRecordFixture({
        id, credentials, dataKey: key, sessionTag: 'tag',
        active: surface === 'attach',
        metadata,
      });
      const legacy = createSessionRecordFixture({
        id: 'legacy-retained-session', active: surface === 'attach',
        tag: 'verified-tag', path: '/unverified', host: 'unverified-host', title: 'Unverified sideband',
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes })),
        metadata: encodeBase64(encrypt(key, 'dataKey', { ...metadata, tag: 'unverified-tag', path: '/unverified', claudeSessionId: 'unverified-vendor' })),
        ...(surface === 'policy-refused-list' || surface === 'selected-plain' ? { encryptionMode: 'plain', metadata: JSON.stringify(metadata) } : {}),
      });
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const path = new URL(url).pathname;
        const row = [valid, legacy].find((row) => path === `/v2/sessions/${row.id}`);
        if (row) return { status: 200, data: { session: row } };
        if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/archived') {
          return { status: 200, data: { sessions: path.endsWith('/archived') ? [] : [legacy, valid], hasNext: false, nextCursor: null } };
        }
        return { status: 404, data: {} };
      });

      if (surface === 'prefix' || surface === 'tag') {
        await expect(resolveSessionTransportContext({ credentials, idOrPrefix: surface === 'prefix' ? 'session-' : 'verified-tag' }))
          .resolves.toMatchObject({ ok: true, sessionId: id, ctx: { encryptionKey: key } });
      } else if (surface === 'list' || surface === 'policy-refused-list') {
        const result = await listSessions({ credentials, activeOnly: false, archivedOnly: false, includeSystem: false, resumableOnly: false, includeRows: true });
        expect(result.sessions.map((row) => row.id)).toEqual([legacy.id, id]);
        expect(result.sessions[0]).not.toHaveProperty('path');
        expect(result.sessions[0]).not.toHaveProperty('tag');
        expect(result.sessions[0]).not.toHaveProperty('title');
        expect(result.sessions[0]).not.toHaveProperty('host');
        expect(result.sessions[0]?.vendorResumeEligible).toBe(false);
        expect(result.sessions[1]).toMatchObject({ title: 'Verified owner', path: '/verified', vendorResumeEligible: true });
      } else if (surface === 'resume') {
        const result = await buildResumeSelectionModel({ credentials, accountSettings: accountSettingsParse({}), fetchSessionsPageFn: fetchSessionsPage });
        expect(result.rows).toEqual([
          expect.objectContaining({ sessionId: id, disabled: false, path: '/verified' }),
          expect.objectContaining({ sessionId: legacy.id, disabled: true, path: '' }),
        ]);
      } else if (surface === 'attach') {
        const localInfo = vi.fn(async () => null);
        const result = await buildAttachSelectionModel({
          credentials, accountSettings: accountSettingsParse({}), currentMachineId: 'synthetic-machine', currentMachineHost: 'synthetic-host',
          fetchSessionsPageFn: fetchSessionsPage, readTerminalAttachmentInfoFn: localInfo, isTmuxAvailableFn: async () => true,
        });
        expect(result.rows.some((row) => row.sessionId === id)).toBe(true);
        expect(result.rows.some((row) => row.sessionId === legacy.id && !row.disabled)).toBe(false);
        expect(localInfo).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: legacy.id }));
        expect(await result.probeSessionIdFn(legacy.id)).toMatchObject({ reachable: false });
      } else if (surface === 'selected-legacy') {
        await expect(resolveSessionIdOrPrefix({ credentials, idOrPrefix: 'legacy-' })).resolves.toMatchObject({ ok: true, sessionId: legacy.id });
        await expect(resolveSessionTransportContext({ credentials, idOrPrefix: 'legacy-' }))
          .rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
      } else if (surface === 'selected-plain') {
        await expect(resolveSessionTransportContext({ credentials, idOrPrefix: legacy.id }))
          .rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED', retryable: false });
      } else {
        await expect(resolveSessionIdOrPrefix({ credentials, idOrPrefix: 'unverified-tag' })).resolves.toMatchObject({ ok: false, code: 'session_not_found' });
      }
    },
  );

  it('resolves an authenticated session key distinct from account material', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createEncryptedSessionRecordFixture({
      id, credentials, dataKey: key, sessionTag: 'tag', metadata: { path: '/verified' },
    }) } });
    const result = await resolveSessionTransportContext({ credentials, idOrPrefix: id });
    expect(result).toMatchObject({ ok: true, sessionId: id, mode: 'e2ee', ctx: { encryptionVariant: 'dataKey', encryptionKey: key } });
  });

  it.each(['missing', 'anonymous', 'transplant'] as const)('rejects %s without retry or fallback', async (attack) => {
    const dataEncryptionKey = attack === 'missing' ? null
      : attack === 'transplant' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes }))
        : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes }));
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({
      id, dataEncryptionKey, metadata: encodeBase64(encrypt(key, 'dataKey', { path: '/synthetic' })),
    }) } });
    await expect(resolveSessionTransportContext({ credentials, idOrPrefix: id }))
      .rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
    expect(get.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('rejects a binding that names a different session', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createEncryptedSessionRecordFixture({
      id, credentials, dataKey: key, sessionTag: 'tag', metadata: { path: '/synthetic' },
      binding: { sessionId: 'different-session', sessionTag: 'tag' },
    }) } });
    await expect(resolveSessionTransportContext({ credentials, idOrPrefix: id }))
      .rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
  });

  it('treats a decryptable row without a binding as retryable pending', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createEncryptedSessionRecordFixture({
      id, credentials, dataKey: key, sessionTag: 'tag', metadata: { path: '/synthetic' }, binding: null,
    }) } });
    await expect(resolveSessionTransportContext({ credentials, idOrPrefix: id }))
      .rejects.toMatchObject({ code: 'SESSION_KEY_BINDING_PENDING', retryable: true });
  });

  it('refetches an e2ee session when the published owner envelope is briefly missing', async () => {
    vi.stubEnv('HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS', '3');
    vi.stubEnv('HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS', '1');
    const authenticated = createEncryptedSessionRecordFixture({
      id, credentials, dataKey: key, sessionTag: 'tag', metadata: { path: '/verified' },
    });
    const missing = { ...authenticated, dataEncryptionKey: null };
    const get = vi.spyOn(axios, 'get');
    get.mockResolvedValueOnce({ status: 200, data: { session: missing } })
      .mockResolvedValueOnce({ status: 200, data: { session: missing } })
      .mockResolvedValue({ status: 200, data: { session: authenticated } });
    const result = await resolveSessionTransportContext({ credentials, idOrPrefix: id });
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ ok: true, sessionId: id, mode: 'e2ee' });
    if (!result.ok) throw new Error(`Expected resolved session transport context, got ${JSON.stringify(result)}`);
    if (result.ctx.encryptionVariant === 'plain') throw new Error('Expected encrypted context');
    expect(Array.from(result.ctx.encryptionKey)).toEqual(Array.from(key));
  });
  it.each(['attach', 'replay', 'memory', 'target-action', 'metadata', 'runtime-auth-event', 'quota-event'] as const)('%s cannot consume a relay-chosen anonymous key', async (surface) => {
    const anonymous = sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes });
    const rawSession = createSessionRecordFixture({
      id, dataEncryptionKey: encodeBase64(anonymous), metadata: encodeBase64(encrypt(key, 'dataKey', { path: '/synthetic' })),
    });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: rawSession } });
    const post = vi.spyOn(axios, 'post');
    const operations = {
      attach: () => resolveExistingSessionAttachContext({ credentials, token: credentials.token, sessionId: id, backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }),
      replay: () => hydrateReplayDialogFromTranscript({ credentials, previousSessionId: id, limit: 10 }),
      memory: () => getMemoryWindow({ credentials, sessionId: id, seqFrom: 1, seqTo: 10, paddingMessages: 0 }),
      'target-action': () => createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global' }).executionRunStop!(id, { runId: 'run' }),
      metadata: () => updateSessionMetadataWithRetry({ credentials, token: credentials.token, sessionId: id, rawSession, updater: (metadata) => ({ ...metadata, changed: true }) }),
      'runtime-auth-event': () => commitConnectedServiceRuntimeAuthRecoverySessionEvent({
        credentials, sessionId: id, event: {
          type: 'connected-service-runtime-auth-recovery', status: 'retry_scheduled', serviceId: 'openai-codex', terminal: false, nextRetryAtMs: 31000,
          diagnostic: { code: 'recovery_retry_scheduled', source: 'runtime_auth_recovery', failurePhase: 'runtime_auth_recovery', serviceId: 'openai-codex', retryable: true, suggestedActions: ['retry'] },
        },
      }),
      'quota-event': () => commitConnectedServiceQuotaLifecycleSessionEvents({
        credentials, transition: { phase: 'blocked', serviceId: 'openai-codex', groupId: 'main', activeProfileId: 'primary', sessionIds: [id], cycleId: 'cycle', issueFingerprint: 'quota-blocked', resetAtMs: 1900000, reason: 'connected_service_group_quota_exhausted' },
      }),
    };
    await expect(operations[surface]()).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
    expect(post).not.toHaveBeenCalled();
  });
});
