import { describe, expect, it } from 'vitest';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './encryptionKey';
import { deriveBoxPublicKeyFromSeed, openEncryptedDataKeyEnvelopeV1, openOwnerSessionDataKeyEnvelope } from '@happier-dev/protocol';

describe('token-only encryption context', () => {
  it('refuses encrypted operations without account key material', () => {
    expect(() => resolveSessionEncryptionContext({ token: 'plain', encryption: null }, 'tag'))
      .toThrowError(expect.objectContaining({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' }));
    expect(() => resolveMachineEncryptionContext({ token: 'plain', encryption: null }))
      .toThrowError(expect.objectContaining({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' }));
  });
});

describe('resolveSessionEncryptionContext', () => {
  it('keeps machine keys on the generic V1 envelope contract', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credential = {
      token: 'synthetic-token',
      encryption: { type: 'dataKey' as const, machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) },
    };
    const context = resolveMachineEncryptionContext(credential);
    expect(context.encryptionKey).toBe(machineKey);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: context.dataEncryptionKey!, recipientSecretKeyOrSeed: machineKey })).toEqual(machineKey);
    expect(openOwnerSessionDataKeyEnvelope({ material: credential.encryption, envelope: context.dataEncryptionKey! })).toBeNull();
  });
  it('generates a per-session AES key and publishes a tag-bound dataEncryptionKey bundle', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = new Uint8Array(32).fill(3);

    const credential = {
      token: 't',
      encryption: {
        type: 'dataKey' as const,
        publicKey,
        machineKey,
      },
    };
    const res = resolveSessionEncryptionContext(credential, 'tag');

    expect(res.encryptionVariant).toBe('dataKey');
    expect(res.encryptionKey).toBeInstanceOf(Uint8Array);
    expect(res.encryptionKey.length).toBe(32);
    expect(res.dataEncryptionKey).not.toBeNull();
    const opened = openOwnerSessionDataKeyEnvelope({
      material: credential.encryption, sessionTag: 'tag', envelope: res.dataEncryptionKey!,
    });
    expect(opened?.sessionTag).toBe('tag');
    expect(opened?.dataKey).toEqual(res.encryptionKey);
  });
});
