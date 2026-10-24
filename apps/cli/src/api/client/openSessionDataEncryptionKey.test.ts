import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { requireEncryptionCredentials } from '@/persistence';
import { encodeBase64 } from '../encryption';
import { openSessionDataEncryptionKey } from './openSessionDataEncryptionKey';

describe('owner session data-key authentication', () => {
  it.each(['replacement', 'machine'] as const)('rejects an anonymous %s envelope', (kind) => {
    const account = tweetnacl.box.keyPair();
    const credential: Credentials = {
      token: 'synthetic-token',
      encryption: { type: 'dataKey', publicKey: account.publicKey, machineKey: account.secretKey },
    };
    requireEncryptionCredentials(credential);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: kind === 'machine' ? account.secretKey : randomBytes(32),
      recipientPublicKey: account.publicKey,
      randomBytes,
    });
    const input = {
      credential,
      expectedSessionTag: 'owner-session',
      encryptedDataEncryptionKeyBase64: encodeBase64(envelope),
    };

    expect(openSessionDataEncryptionKey(input)).toBeNull();
  });
});
