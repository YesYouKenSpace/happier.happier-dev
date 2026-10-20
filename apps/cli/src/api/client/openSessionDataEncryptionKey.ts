import { openOwnerSessionDataKeyEnvelope, type AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import { decodeBase64 } from '../encryption';

export type OpenedSessionDataKey = Readonly<{
  sessionTag: string;
  dataKey: Uint8Array;
}>;

export function openSessionDataEncryptionKey(params: {
  credential: Readonly<{ encryption: AccountScopedCryptoMaterial }>;
  expectedSessionTag?: string;
  encryptedDataEncryptionKeyBase64: string | null | undefined;
}): OpenedSessionDataKey | null {
  const encryptedBase64 = params.encryptedDataEncryptionKeyBase64;
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.length === 0) {
    return null;
  }

  try {
    return openOwnerSessionDataKeyEnvelope({
      material: params.credential.encryption,
      sessionTag: params.expectedSessionTag,
      envelope: decodeBase64(encryptedBase64),
    });
  } catch {
    return null;
  }
}
