import {
  readSessionKeyBindingV1,
  SessionKeyAuthenticationError,
  SessionKeyBindingPendingError,
  verifySessionKeyBindingV1,
} from '@happier-dev/protocol';
import { decodeBase64, decrypt } from '@/api/encryption';

export function decryptOwnerSessionMetadataRecord(params: Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadataBase64: string;
}>): Record<string, unknown> | null {
  try {
    const decrypted = decrypt(
      params.encryptionKey,
      params.encryptionVariant,
      decodeBase64(params.metadataBase64, 'base64'),
    );
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return decrypted as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Verify the session-ID binding inside DEK-encrypted metadata. The envelope authenticates
 * the key to the account and names its creation tag; this check binds key, row ID, and tag
 * together so a relay cannot serve another session's row under a requested ID.
 */
export function verifyOwnerSessionKeyBinding(params: Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  rawSession: Readonly<{ id?: unknown; metadata?: unknown }>;
  envelopeSessionTag: string;
}>): Record<string, unknown> {
  const sessionId = typeof params.rawSession.id === 'string' ? params.rawSession.id : '';
  const metadataBase64 = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
  if (!sessionId || !metadataBase64) throw new SessionKeyAuthenticationError();
  const record = decryptOwnerSessionMetadataRecord({
    encryptionKey: params.encryptionKey,
    encryptionVariant: params.encryptionVariant,
    metadataBase64,
  });
  if (!record) throw new SessionKeyAuthenticationError();
  const binding = readSessionKeyBindingV1(record);
  if (!binding) throw new SessionKeyBindingPendingError();
  if (!verifySessionKeyBindingV1({
    binding,
    sessionId,
    sessionTag: params.envelopeSessionTag,
  })) {
    throw new SessionKeyAuthenticationError();
  }
  return record;
}
