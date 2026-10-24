import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import {
  readPendingLocalId,
  SessionKeyAuthenticationError,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

export async function enqueueAutomationPrompt(params: {
  token: string;
  encryption?: AccountScopedCryptoMaterial;
  sessionId: string;
  prompt: string;
  displayText?: string;
  sessionEncryptionMode: 'e2ee' | 'plain';
  localId?: string;
}): Promise<void> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    return;
  }

  const localId = readPendingLocalId(params.localId) ?? randomUUID();
  const displayText = typeof params.displayText === 'string' ? params.displayText : undefined;
  const rawSession = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
  if (!rawSession) throw new SessionKeyAuthenticationError();
  const mode = resolveSessionStoredContentEncryptionMode(rawSession);
  if (params.sessionEncryptionMode === 'e2ee' && mode === 'plain') throw new SessionKeyAuthenticationError();
  if (mode !== 'plain' && !params.encryption) throw new SessionKeyAuthenticationError();
  const encryption = params.encryption;
  // The daemon carries the account box secret without its public half; derive it the same
  // way as the artifact store so the strict resolver receives full credentials.
  // A missing account key is only tolerable for plaintext rows (fail-closed above otherwise).
  const credentials: Credentials = !encryption
    ? { token: params.token, encryption: null }
    : encryption.type === 'legacy'
      ? { token: params.token, encryption }
      : {
        token: params.token,
        encryption: {
          ...encryption,
          publicKey: libsodiumPublicKeyFromSecretKey(encryption.machineKey),
        },
      };
  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const message = {
    role: 'user' as const,
    content: { type: 'text' as const, text: prompt },
    meta: {
      sentFrom: 'cli',
      source: 'automation',
      ...(displayText?.trim() ? { displayText } : {}),
    },
  };
  const body = {
    localId,
    messageRole: 'user' as const,
    requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    ...(mode === 'plain'
      ? { content: { t: 'plain' as const, v: message } }
      : { ciphertext: encryptSessionPayload({ ctx, payload: message }) }),
  };

  await enqueuePendingQueueV2MessageViaHttp({
    token: params.token,
    sessionId: params.sessionId,
    body,
  });
}
