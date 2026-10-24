import { createHmac } from 'node:crypto';

import {
  normalizeSessionMetadataForRead,
  SessionKeyAuthenticationError,
  SessionKeyBindingPendingError,
  readSessionKeyBindingV1,
  stringifySerializedJsonValue,
} from '@happier-dev/protocol';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';
import { decodeBase64, decrypt, encodeBase64, encrypt, encryptWithDerivedNonce } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { decryptOwnerSessionMetadataRecord, verifyOwnerSessionKeyBinding } from '@/session/transport/encryption/sessionKeyBinding';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

export type EncryptedSessionEncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

export type SessionEncryptionContext = EncryptedSessionEncryptionContext | Readonly<{
  encryptionKey: null;
  encryptionVariant: 'plain';
}>;

export function requireEncryptedSessionContext(ctx: Readonly<{ encryptionKey: Uint8Array | null; encryptionVariant: 'legacy' | 'dataKey' | 'plain' }>): asserts ctx is EncryptedSessionEncryptionContext {
  if (ctx.encryptionVariant === 'plain' || ctx.encryptionKey === null) {
    throw Object.assign(new Error('Account encryption key material is required'), { code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' });
  }
}

export type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export function resolveSessionStoredContentEncryptionMode(rawSession?: Readonly<{ encryptionMode?: unknown }>): SessionStoredContentEncryptionMode {
  return rawSession?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

export function resolveSessionEncryptionContextFromCredentials(
  credentials: Credentials,
  rawSession?: Readonly<{ id?: unknown; metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>,
  sessionTag?: string,
): SessionEncryptionContext {
  const mode = resolveSessionStoredContentEncryptionMode(rawSession);
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(mode);
  if (mode === 'plain' || (!rawSession && !credentials.encryption)) {
    return { encryptionKey: null, encryptionVariant: 'plain' };
  }
  requireEncryptionCredentials(credentials);

  if (typeof rawSession?.id !== 'string' || !rawSession.id) throw new SessionKeyAuthenticationError();

  const encryptedDekBase64 =
    typeof rawSession.dataEncryptionKey === 'string' ? rawSession.dataEncryptionKey.trim() : '';

  if (!encryptedDekBase64) {
    // Pre-cutover rows carry no envelope; only the account key itself can open them, so a
    // relay can replay but never forge them. A present-but-unopenable envelope below stays
    // strictly rejected: anyone holding the account public key can mint those.
    const fallbackKey = credentials.encryption.type === 'legacy'
      ? credentials.encryption.secret
      : credentials.encryption.machineKey;
    const fallbackVariant: 'legacy' | 'dataKey' = credentials.encryption.type;
    const metadataBase64 = typeof rawSession.metadata === 'string' ? rawSession.metadata.trim() : '';
    const record = metadataBase64
      ? decryptOwnerSessionMetadataRecord({
        encryptionKey: fallbackKey,
        encryptionVariant: fallbackVariant,
        metadataBase64,
      })
      : null;
    if (!record) throw new SessionKeyAuthenticationError();
    // Bindings postdate these rows, but verify one when present so a tampered row that
    // still decrypts cannot silently change sessions.
    const binding = readSessionKeyBindingV1(record);
    if (binding && binding.sessionId !== rawSession.id) throw new SessionKeyAuthenticationError();
    return { encryptionKey: fallbackKey, encryptionVariant: fallbackVariant };
  }

  const opened = openSessionDataEncryptionKey({
    credential: credentials,
    expectedSessionTag: sessionTag,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64 || null,
  });
  if (!opened) throw new SessionKeyAuthenticationError();
  // The metadata ciphertext authenticates the ID binding under the envelope's key; without
  // it a relay could serve another session's consistent row under the requested ID.
  verifyOwnerSessionKeyBinding({
    encryptionKey: opened.dataKey,
    encryptionVariant: 'dataKey',
    rawSession,
    envelopeSessionTag: opened.sessionTag,
  });
  return { encryptionKey: opened.dataKey, encryptionVariant: 'dataKey' };
}

export function tryDecryptSessionMetadata(params: Readonly<{
  credentials: Credentials;
  rawSession: Readonly<{ id?: unknown; metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
}>): Record<string, unknown> | null {
  const encryptedMetadataBase64 =
    typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  if (!encryptedMetadataBase64) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(mode);
  if (mode === 'plain') {
    try {
      return normalizeSessionMetadataForRead(tryParseJsonRecord(encryptedMetadataBase64));
    } catch {
      return null;
    }
  }

  // Key-establishment failures degrade to unavailable metadata here; callers that
  // execute against the session resolve the strict context directly and stay fail-closed.
  // (Upstream callers such as the Agent bridge handle null the same way.)
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';
  try {
    const ctx = resolveSessionEncryptionContextFromCredentials(
      params.credentials,
      params.rawSession,
    );
    requireEncryptedSessionContext(ctx);
    ({ encryptionKey, encryptionVariant } = ctx);
  } catch (error) {
    if (error instanceof SessionKeyAuthenticationError || error instanceof SessionKeyBindingPendingError) {
      return null;
    }
    throw error;
  }

  try {
    const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedMetadataBase64, 'base64'));
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return normalizeSessionMetadataForRead(decrypted as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function encryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  payload: unknown;
}>): string {
  if (params.mode === 'plain') {
    return JSON.stringify(params.payload);
  }
  requireEncryptedSessionContext(params.ctx);
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  value: string;
}>): unknown {
  const raw = params.value.trim();
  if (params.mode === 'plain') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  requireEncryptedSessionContext(params.ctx);
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(raw, 'base64'),
  );
}

export function encryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  payload: unknown;
  idempotencyKey?: string;
}>): string {
  requireEncryptedSessionContext(params.ctx);
  const nonce = params.idempotencyKey === undefined
    ? undefined
    : deriveIdempotentSessionPayloadNonce({
        ctx: params.ctx,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
      });
  const ciphertext = nonce === undefined
    ? encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload)
    : encryptWithDerivedNonce(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload, nonce);
  return encodeBase64(ciphertext, 'base64');
}

/**
 * Keep these exact bytes for the existing idempotent Session-payload namespace.
 * The `session-pending` wording is historical: this shared primitive also
 * supports transition dividers. Retain it to preserve durable Pending retry
 * ciphertext; changing it would change a predecessor-created row on retry.
 */
const IDEMPOTENT_SESSION_PAYLOAD_NONCE_DOMAIN_V1 =
  'happier.session-pending.idempotent-content.v1';

function deriveIdempotentSessionPayloadNonce(params: Readonly<{
  ctx: SessionEncryptionContext;
  idempotencyKey: string;
  payload: unknown;
}>): Uint8Array {
  requireEncryptedSessionContext(params.ctx);
  // A keyed synthetic nonce makes same-ID/same-content retries byte-identical
  // without reusing a nonce when either the identity or plaintext changes.
  const fields = [
    IDEMPOTENT_SESSION_PAYLOAD_NONCE_DOMAIN_V1,
    params.ctx.encryptionVariant,
    params.idempotencyKey,
    stringifySerializedJsonValue(params.payload),
  ];
  const encodedFields = fields.map((field) => new TextEncoder().encode(field));
  const totalLength = encodedFields.reduce((total, field) => total + 4 + field.length, 0);
  const input = new Uint8Array(totalLength);
  const view = new DataView(input.buffer);
  let offset = 0;
  for (const field of encodedFields) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    input.set(field, offset);
    offset += field.length;
  }
  const digest = createHmac('sha256', params.ctx.encryptionKey).update(input).digest();
  const nonceLength = params.ctx.encryptionVariant === 'legacy' ? 24 : 12;
  return new Uint8Array(digest.subarray(0, nonceLength));
}

export function decryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  ciphertextBase64: string;
}>): unknown {
  requireEncryptedSessionContext(params.ctx);
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(params.ciphertextBase64, 'base64'),
  );
}
