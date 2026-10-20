import type { Credentials } from '@/persistence';
import { requireEncryptionCredentials } from '@/persistence';

import { sealEncryptedDataKeyEnvelopeV1, sealOwnerSessionDataKeyEnvelope } from '@happier-dev/protocol';
import { getRandomBytes } from '../encryption';

export type EncryptionContext = {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  dataEncryptionKey: Uint8Array | null;
};

export function resolveSessionEncryptionContext(credential: Credentials, sessionTag: string): EncryptionContext {
  requireEncryptionCredentials(credential);
  const encryptionKey = getRandomBytes(32);
  const dataEncryptionKey = sealOwnerSessionDataKeyEnvelope({
    material: credential.encryption,
    sessionTag,
    dataKey: encryptionKey,
    randomBytes: getRandomBytes,
  });
  return { encryptionKey, encryptionVariant: 'dataKey', dataEncryptionKey };
}

export function resolveMachineEncryptionContext(credential: Credentials): EncryptionContext {
  requireEncryptionCredentials(credential);
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (credential.encryption.type === 'dataKey') {
    // Encrypt data encryption key
    encryptionVariant = 'dataKey';
    encryptionKey = credential.encryption.machineKey;
    dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: credential.encryption.machineKey,
      recipientPublicKey: credential.encryption.publicKey,
      randomBytes: getRandomBytes,
    });
  } else {
    // Legacy encryption
    encryptionKey = credential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}
