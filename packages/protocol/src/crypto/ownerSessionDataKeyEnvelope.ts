import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from './accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from './base64.js';

const payloadSchema = z.object({
  v: z.literal(1),
  sessionTag: z.string().min(1),
  dataKey: z.string().length(44),
}).strict();

/**
 * The session-ID binding lives inside DEK-encrypted session metadata, not in the envelope:
 * the server assigns the row ID after the envelope is sealed, and stock relays neither
 * accept client-chosen IDs nor expose the row tag on by-ID reads. The metadata ciphertext
 * itself authenticates the binding under the envelope's key.
 */
export const SESSION_KEY_BINDING_METADATA_FIELD = 'sessionKeyBindingV1';

export const SessionKeyBindingV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  sessionTag: z.string().min(1),
}).strict();

export type SessionKeyBindingV1 = z.infer<typeof SessionKeyBindingV1Schema>;

export class SessionKeyAuthenticationError extends Error {
  readonly code = 'SESSION_KEY_AUTHENTICATION_FAILED';
  readonly retryable = false;

  constructor() {
    super('Session key authentication failed. Legacy or shared encrypted sessions require a trusted upgrade; create a new session with updated clients.');
    this.name = 'SessionKeyAuthenticationError';
  }
}

/**
 * A decryptable owner row whose metadata does not yet carry the ID binding: the creating
 * client patches the binding immediately after creation, so this is a short race or a
 * relay replaying pre-binding metadata. Retryable so callers refetch instead of failing
 * the session permanently.
 */
export class SessionKeyBindingPendingError extends Error {
  readonly code = 'SESSION_KEY_BINDING_PENDING';
  readonly retryable = true;

  constructor() {
    super('Session key binding is not yet published for this session; retry after the creating client completes its metadata update.');
    this.name = 'SessionKeyBindingPendingError';
  }
}

export function sealOwnerSessionDataKeyEnvelope(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  sessionTag: string;
  dataKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): Uint8Array {
  const secret = params.material.type === 'dataKey' ? params.material.machineKey : params.material.secret;
  if (secret.length !== 32 || params.dataKey.length !== 32) throw new SessionKeyAuthenticationError();
  const payload = payloadSchema.parse({
    v: 1,
    sessionTag: params.sessionTag,
    dataKey: encodeBase64(params.dataKey),
  });
  return decodeBase64(sealAccountScopedBlobCiphertext({
    kind: 'owner_session_data_key',
    material: params.material,
    payload,
    randomBytes: params.randomBytes,
  }));
}

export function openOwnerSessionDataKeyEnvelope(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  envelope: Uint8Array;
  sessionTag?: string;
}>): Readonly<{ sessionTag: string; dataKey: Uint8Array }> | null {
  const secret = params.material.type === 'dataKey' ? params.material.machineKey : params.material.secret;
  if (secret.length !== 32) return null;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'owner_session_data_key',
    material: params.material,
    ciphertext: encodeBase64(params.envelope),
  });
  // Legacy account blobs have no authenticated purpose and cannot establish session authority.
  if (opened?.format !== 'account_scoped_v1') return null;
  const parsed = payloadSchema.safeParse(opened.value);
  if (!parsed.success) return null;
  if (params.sessionTag !== undefined && parsed.data.sessionTag !== params.sessionTag) return null;
  try {
    const dataKey = decodeBase64(parsed.data.dataKey);
    if (dataKey.length !== 32) return null;
    return { sessionTag: parsed.data.sessionTag, dataKey };
  } catch {
    return null;
  }
}

export function readSessionKeyBindingV1(metadataRecord: Record<string, unknown>): SessionKeyBindingV1 | null {
  const raw = metadataRecord[SESSION_KEY_BINDING_METADATA_FIELD];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = SessionKeyBindingV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function verifySessionKeyBindingV1(params: Readonly<{
  binding: SessionKeyBindingV1 | null;
  sessionId: string;
  sessionTag?: string;
}>): boolean {
  if (!params.binding) return false;
  if (params.binding.sessionId !== params.sessionId) return false;
  if (params.sessionTag !== undefined && params.binding.sessionTag !== params.sessionTag) return false;
  return true;
}

export function buildSessionKeyBindingMetadataField(params: Readonly<{
  sessionId: string;
  sessionTag: string;
}>): Record<string, SessionKeyBindingV1> {
  return { [SESSION_KEY_BINDING_METADATA_FIELD]: SessionKeyBindingV1Schema.parse({ v: 1, ...params }) };
}
