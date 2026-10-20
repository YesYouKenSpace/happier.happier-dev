import { randomUUID } from 'node:crypto';

import {
  readPendingLocalId,
  SessionKeyAuthenticationError,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

export async function enqueueAutomationPrompt(params: {
  token: string;
  encryption: AccountScopedCryptoMaterial;
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
  const ctx = resolveSessionEncryptionContextFromCredentials(params, rawSession);
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
