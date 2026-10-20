import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionKeyBindingMetadataField,
  openOwnerSessionDataKeyEnvelope,
  readSessionKeyBindingV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealOwnerSessionDataKeyEnvelope,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { ApiClient } from './api';
import { decodeBase64, decrypt, encodeBase64, encrypt, libsodiumPublicKeyFromSecretKey } from './encryption';

const metadata = createTestMetadata();
const tag = 'owner-tag';
const sessionId = 'stored-session';
const dataKey = new Uint8Array(randomBytes(32));

describe.each(['legacy', 'dataKey'] as const)('owner session create/load (%s credentials)', (type) => {
  const secret = randomBytes(32);
  const credential: Credentials = {
    token: 'synthetic-token',
    encryption: type === 'legacy'
      ? { type, secret }
      : { type, machineKey: secret, publicKey: libsodiumPublicKeyFromSecretKey(secret) },
  };
  const envelope = (sessionTag = tag) => encodeBase64(sealOwnerSessionDataKeyEnvelope({
    material: credential.encryption, sessionTag, dataKey, randomBytes,
  }));
  const metadataCiphertext = (binding?: { sessionId: string; sessionTag: string } | null) => encodeBase64(
    encrypt(dataKey, 'dataKey', binding === null
      ? metadata
      : { ...metadata, ...buildSessionKeyBindingMetadataField(binding ?? { sessionId, sessionTag: tag }) }),
  );
  const stored = (dataEncryptionKey: string | null, binding?: { sessionId: string; sessionTag: string } | null) =>
    createSessionRecordFixture({
      id: sessionId, encryptionMode: 'e2ee', dataEncryptionKey,
      metadata: metadataCiphertext(binding),
      metadataVersion: 1,
    });

  beforeEach(() => {
    resetServerFeaturesClientForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe.each(['api', 'http'] as const)('%s owner', (owner) => {
    const create = async () => owner === 'api'
      ? (await ApiClient.create(credential)).getOrCreateSession({ tag, metadata, state: null })
      : getOrCreateSessionByTag({ credentials: credential, tag, metadata, agentState: null });
    const mockBindingPatch = () => vi.spyOn(axios, 'patch').mockResolvedValue({
      status: 200, data: { success: true, metadata: { version: 2 } },
    });

    it('creates a random AES key bound to the requested tag, then publishes the ID binding in metadata', async () => {
      let requestEnvelope: string;
      let requestMetadata: string;
      let requestDataKey: Uint8Array | undefined;
      const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const request = body as Record<string, unknown>;
        expect(request.id).toBeUndefined();
        expect(request.tag).toBe(tag);
        requestEnvelope = request.dataEncryptionKey as string;
        requestMetadata = request.metadata as string;
        const opened = openOwnerSessionDataKeyEnvelope({
          material: credential.encryption, sessionTag: tag, envelope: decodeBase64(requestEnvelope),
        });
        expect(opened?.sessionTag).toBe(tag);
        expect(Array.from(opened?.dataKey ?? [])).not.toEqual(Array.from(secret));
        requestDataKey = opened!.dataKey;
        expect(readSessionKeyBindingV1(decrypt(opened!.dataKey, 'dataKey', decodeBase64(requestMetadata)))).toBeNull();
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, dataEncryptionKey: requestEnvelope, metadata: requestMetadata, metadataVersion: 0,
        }), resolution: 'created' } };
      });
      const patch = mockBindingPatch();
      const result = await create();
      expect(post.mock.calls[0]?.[1]).toMatchObject({ tag });
      expect(result && ('session' in result ? result.session.id : result.id)).toBe(sessionId);
      expect(patch).toHaveBeenCalledTimes(1);
      const patchedCiphertext = (patch.mock.calls[0]?.[1] as { metadata: { ciphertext: string } }).metadata.ciphertext;
      const patchedRecord = decrypt(requestDataKey!, 'dataKey', decodeBase64(patchedCiphertext));
      expect(readSessionKeyBindingV1(patchedRecord)).toEqual({ v: 1, sessionId, sessionTag: tag });
      if (result && 'created' in result) expect(result.created).toBe(true);
      if (result && 'encryptionKey' in result) {
        expect(result.encryptionKey).toEqual(requestDataKey!);
        expect(result.metadata).toEqual(patchedRecord);
      }
    });

    it('loads the original key and published binding for the requested tag without rewriting metadata', async () => {
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { session: stored(envelope()), resolution: 'existing' } });
      const patch = mockBindingPatch();
      const result = await create();
      expect(post.mock.calls[0]?.[1]).toMatchObject({ tag });
      expect(patch).not.toHaveBeenCalled();
      expect(result).not.toBeNull();
      if (result && 'created' in result) expect(result.created).toBe(false);
      if (result && 'encryptionKey' in result) {
        expect(result.encryptionKey).toEqual(dataKey);
        expect(result.metadata).toEqual({ ...metadata, ...buildSessionKeyBindingMetadataField({ sessionId, sessionTag: tag }) });
      }
    });

    it('self-heals a binding-less row by publishing the binding before returning', async () => {
      vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
        session: stored(envelope(), null), resolution: 'created',
      } });
      const patch = mockBindingPatch();
      const result = await create();
      expect(patch).toHaveBeenCalledTimes(1);
      if (result && 'session' in result) {
        expect(result.session.metadataVersion).toBe(2);
        expect(readSessionKeyBindingV1(decrypt(dataKey, 'dataKey', decodeBase64(result.session.metadata))))
          .toEqual({ v: 1, sessionId, sessionTag: tag });
      }
    });

    it('rejects a version-conflict row that still has no binding as retryable pending', async () => {
      const stale = metadataCiphertext(null);
      vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
        session: stored(envelope(), null), resolution: 'created',
      } });
      vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
        success: false, error: 'version-mismatch', metadata: { version: 3, value: stale },
      } });
      await expect(create()).rejects.toMatchObject({ code: 'SESSION_KEY_BINDING_PENDING', retryable: true });
    });

    it('rejects a plaintext response when this client requires E2EE', async () => {
      const { configuration } = await import('@/configuration');
      const previous = configuration.clientEncryptionRequirement;
      Object.assign(configuration, { clientEncryptionRequirement: 'require_e2ee' });
      try {
        const row = stored(envelope());
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
          session: { ...row, encryptionMode: 'plain' }, resolution: 'created',
        } });
        const patch = mockBindingPatch();
        await expect(create()).rejects.toThrow(/requires end-to-end encryption.*plaintext storage/);
        expect(patch).not.toHaveBeenCalled();
      } finally {
        Object.assign(configuration, { clientEncryptionRequirement: previous });
      }
    });

    it.each(['missing', 'malformed', 'anonymous', 'wrong-tag', 'wrong-account', 'binding-wrong-id', 'binding-wrong-tag', 'undecryptable-metadata'] as const)(
      'rejects %s without returning usable context', async (attack) => {
        const anonymous = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
          dataKey, recipientPublicKey: libsodiumPublicKeyFromSecretKey(secret), randomBytes,
        }));
        const row = attack === 'binding-wrong-id'
          ? stored(envelope(), { sessionId: 'other-session', sessionTag: tag })
          : attack === 'binding-wrong-tag'
            ? stored(envelope(), { sessionId, sessionTag: 'other-tag' })
            : attack === 'undecryptable-metadata'
              ? createSessionRecordFixture({
                id: sessionId, encryptionMode: 'e2ee', dataEncryptionKey: envelope(),
                metadata: encodeBase64(encrypt(new Uint8Array(randomBytes(32)), 'dataKey', metadata)), metadataVersion: 1,
              })
              : stored(attack === 'missing' ? null
                : attack === 'malformed' ? 'not-a-key'
                : attack === 'anonymous' ? anonymous
                : attack === 'wrong-tag' ? envelope('other-tag')
                : attack === 'wrong-account' ? encodeBase64(sealOwnerSessionDataKeyEnvelope({
                  material: { type: 'legacy', secret: randomBytes(32) }, sessionTag: tag, dataKey, randomBytes,
                })) : envelope());
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
          session: { ...row }, resolution: 'created',
        } });
        const patch = mockBindingPatch();
        await expect(create()).rejects.toMatchObject({ code: 'SESSION_KEY_AUTHENTICATION_FAILED', retryable: false });
        expect(patch).not.toHaveBeenCalled();
      },
    );
  });
});
