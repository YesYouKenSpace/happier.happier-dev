import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKeyBindingMetadataField, sealOwnerSessionDataKeyEnvelope } from '@happier-dev/protocol';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { enqueueAutomationPrompt } from './automationPendingQueueClient';
import { configuration } from '@/configuration';

describe('enqueueAutomationPrompt', () => {
  const encryption = { type: 'legacy' as const, secret: new Uint8Array(randomBytes(32)) };
  const input = {
    token: 'synthetic-token', encryption, sessionId: 'session-automation', prompt: 'Hello from automation',
    sessionEncryptionMode: 'plain' as const, localId: '  opaque-automation-id  ',
  };
  const previousRequirement = configuration.clientEncryptionRequirement;
  beforeEach(() => Object.assign(configuration, { clientEncryptionRequirement: 'follow_account' }));
  afterEach(() => {
    Object.assign(configuration, { clientEncryptionRequirement: previousRequirement });
    vi.restoreAllMocks();
  });

  it('resolves the actual authenticated session key, not the template mode/key', async () => {
    const key = randomBytes(32);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({
      id: input.sessionId, dataEncryptionKey: encodeBase64(sealOwnerSessionDataKeyEnvelope({
        material: encryption, sessionTag: 'tag', dataKey: key, randomBytes,
      })),
      metadata: encodeBase64(encrypt(key, 'dataKey', {
        path: '/synthetic',
        ...buildSessionKeyBindingMetadataField({ sessionId: input.sessionId, sessionTag: 'tag' }),
      })),
    }) } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
    await enqueueAutomationPrompt(input);
    const body = post.mock.calls[0]?.[1] as { ciphertext: string };
    expect(decrypt(key, 'dataKey', decodeBase64(body.ciphertext))).toMatchObject({ content: { text: input.prompt } });
  });

  it('rejects missing owner envelope before writing even with a stored template key', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({ id: input.sessionId }) } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
    const poisoned = { ...input, sessionEncryptionMode: 'e2ee' as const, sessionEncryptionKeyBase64: encodeBase64(randomBytes(32)) };
    await expect(enqueueAutomationPrompt(poisoned)).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves plain pending content and opaque local IDs without needing a DEK', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({ id: input.sessionId, encryptionMode: 'plain' }) } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
    await enqueueAutomationPrompt(input);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ localId: input.localId, content: { t: 'plain', v: { content: { text: input.prompt } } } });
  });

  it('rethrows terminal auth failures from enqueue', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({ id: input.sessionId, encryptionMode: 'plain' }) } });
    vi.spyOn(axios, 'post').mockRejectedValue(new HttpStatusError(403, 'Authentication failed'));
    await expect(enqueueAutomationPrompt(input)).rejects.toMatchObject({ response: { status: 403 } });
  });
});
