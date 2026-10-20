import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from './accountScopedCipher.js';
import { decodeBase64 } from './base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from './encryptedDataKeyEnvelopeV1.js';
import {
  openOwnerSessionDataKeyEnvelope,
  readSessionKeyBindingV1,
  sealOwnerSessionDataKeyEnvelope,
  SessionKeyBindingV1Schema,
  verifySessionKeyBindingV1,
} from './ownerSessionDataKeyEnvelope.js';

describe('owner session data-key envelope', () => {
  const recoverySecret = new Uint8Array(32).fill(7);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
  const material = { type: 'dataKey', machineKey } as const;
  const sessionTag = 'creation-a';
  const dataKey = new Uint8Array(32).fill(9);
  const seal = () => sealOwnerSessionDataKeyEnvelope({ material, sessionTag, dataKey, randomBytes });

  it('opens the tag-bound envelope on a paired device and a recovery-secret client', () => {
    const envelope = seal();
    for (const reader of [material, { type: 'legacy', secret: recoverySecret } as const]) {
      const opened = openOwnerSessionDataKeyEnvelope({ material: reader, envelope });
      expect(opened).toEqual({ sessionTag, dataKey });
      expect(opened!.dataKey).not.toEqual(machineKey);
      const withExpectedTag = openOwnerSessionDataKeyEnvelope({ material: reader, envelope, sessionTag });
      expect(withExpectedTag).toEqual({ sessionTag, dataKey });
    }
  });

  it.each(['account', 'tag', 'tamper', 'legacy', 'purpose', 'missing'] as const)(
    'rejects %s substitution',
    (kind) => {
      let envelope = seal();
      const reader = kind === 'account' ? { type: 'dataKey', machineKey: randomBytes(32) } as const : material;
      if (kind === 'tamper') envelope[envelope.length - 1] ^= 1;
      if (kind === 'legacy') {
        envelope = sealEncryptedDataKeyEnvelopeV1({
          dataKey,
          recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
          randomBytes,
        });
      }
      if (kind === 'purpose') {
        envelope = decodeBase64(sealAccountScopedBlobCiphertext({
          material, kind: 'account_settings', payload: { v: 1, sessionTag, dataKey: Buffer.from(dataKey).toString('base64') }, randomBytes,
        }));
      }
      if (kind === 'missing') envelope = new Uint8Array();
      expect(openOwnerSessionDataKeyEnvelope({
        material: reader,
        sessionTag: kind === 'tag' ? 'creation-b' : undefined,
        envelope,
      })).toBeNull();
    },
  );

  it('does not accept generic legacy-secretbox compatibility results', () => {
    const nonce = randomBytes(tweetnacl.secretbox.nonceLength);
    const plaintext = new TextEncoder().encode(JSON.stringify({
      v: 1, sessionTag, dataKey: Buffer.from(dataKey).toString('base64'),
    }));
    const box = tweetnacl.secretbox(plaintext, nonce, machineKey);
    const envelope = new Uint8Array([...nonce, ...box]);
    expect(openOwnerSessionDataKeyEnvelope({ material, envelope })).toBeNull();
  });

  it.each([0, 16, 31, 33])('rejects a %i-byte session key at creation', (length) => {
    expect(() => sealOwnerSessionDataKeyEnvelope({
      material, sessionTag, dataKey: new Uint8Array(length), randomBytes,
    })).toThrow();
  });
});

describe('session key binding v1', () => {
  const binding = { v: 1 as const, sessionId: 'session-a', sessionTag: 'creation-a' };

  it('reads, validates, and verifies a binding record inside decrypted metadata', () => {
    expect(SessionKeyBindingV1Schema.safeParse(binding).success).toBe(true);
    expect(readSessionKeyBindingV1({ unrelated: true })).toBeNull();
    expect(readSessionKeyBindingV1({ sessionKeyBindingV1: binding })).toEqual(binding);
    expect(readSessionKeyBindingV1({ sessionKeyBindingV1: { v: 2, sessionId: 'x', sessionTag: 'y' } })).toBeNull();
    expect(verifySessionKeyBindingV1({ binding, sessionId: 'session-a', sessionTag: 'creation-a' })).toBe(true);
  });

  it.each([
    ['wrong id', { binding, sessionId: 'session-b', sessionTag: 'creation-a' }],
    ['wrong tag', { binding, sessionId: 'session-a', sessionTag: 'creation-b' }],
    ['missing id', { binding, sessionId: '', sessionTag: 'creation-a' }],
  ])('rejects %s', (_kind, params) => {
    expect(verifySessionKeyBindingV1(params as never)).toBe(false);
  });
});
