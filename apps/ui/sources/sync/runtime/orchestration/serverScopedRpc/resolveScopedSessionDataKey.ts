import { SessionKeyAuthenticationError, V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    assertScopedUiSessionEncryptionModeAllowed,
    isUiClientEncryptionRequirementUnavailableError,
} from '@/sync/domains/settings/scopedClientEncryptionRequirement';
import { isUiClientEncryptionRequirementError } from '@/sync/domains/settings/clientEncryptionRequirement';
import { parseToken } from '@/utils/auth/parseToken';
import {
  createNotAuthenticatedError,
  isAuthenticationResponseStatus,
  isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';

import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';
import type { ScopedRpcSessionEncryptionContext } from './serverScopedRpcTypes';

export type ScopedSessionCryptoContext =
  | Readonly<{ encryptionMode: 'plain'; sessionDataKey: null }>
  | Readonly<{ encryptionMode: 'e2ee'; sessionDataKey: Uint8Array }>
  | Readonly<{ encryptionMode: 'unknown'; sessionDataKey: null }>;

// Share transport work, never authority derived from another caller's account secret.
const sessionReads = createScopedResolutionSingleFlight<V2SessionByIdResponse['session'] | null>();

type ScopedSessionKeyParams = Readonly<{
  serverId: string;
  serverUrl: string;
  token: string;
  sessionId: string;
  encryption: ScopedRpcSessionEncryptionContext;
  timeoutMs?: number;
}>;

export async function resolveScopedSessionCryptoContext(params: ScopedSessionKeyParams): Promise<ScopedSessionCryptoContext> {
  const sessionId = params.sessionId.trim();
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const key = JSON.stringify([params.serverId, params.serverUrl, params.token, sessionId]);
  try {
    const session = await sessionReads.run(key, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await runtimeFetchWithServerReachability({
          serverUrl: params.serverUrl,
          token: params.token,
          url: `${params.serverUrl}/v2/sessions/${encodeURIComponent(sessionId)}`,
          init: {
            method: 'GET',
            headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
          },
          timeoutMs,
        });
        if (!response.ok) {
          if (isAuthenticationResponseStatus(response.status)) throw createNotAuthenticatedError();
          return null;
        }
        const parsed = V2SessionByIdResponseSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.session?.id !== sessionId) throw new SessionKeyAuthenticationError();
        return parsed.data.session;
      } finally {
        clearTimeout(timeout);
      }
    });
    if (!session) {
      params.encryption.removeSessionEncryption(sessionId);
      return { encryptionMode: 'unknown', sessionDataKey: null };
    }
    if (session.encryptionMode === 'plain') {
      params.encryption.removeSessionEncryption(sessionId);
      assertScopedUiSessionEncryptionModeAllowed({
        mode: 'plain',
        serverId: params.serverId,
        accountId: parseToken(params.token),
      });
      return { encryptionMode: 'plain', sessionDataKey: null };
    }
    if (!session.dataEncryptionKey) throw new SessionKeyAuthenticationError();
    const sessionDataKey = await params.encryption.decryptSessionEncryptionKey(sessionId, session.dataEncryptionKey);
    if (!sessionDataKey) throw new SessionKeyAuthenticationError();
    // The metadata ciphertext authenticates the ID binding under the envelope's key; without
    // this check a relay could serve another session's consistent row under the requested ID.
    // SessionEncryption.decryptMetadata requires the binding and rejects unbound rows.
    await params.encryption.initializeSessions(new Map([[sessionId, sessionDataKey]]));
    const sessionEncryption = params.encryption.getSessionEncryption(sessionId);
    const metadata = await sessionEncryption?.decryptMetadata(session.metadataVersion, session.metadata);
    if (!metadata) throw new SessionKeyAuthenticationError();
    return { encryptionMode: 'e2ee', sessionDataKey };
  } catch (error) {
    params.encryption.removeSessionEncryption(sessionId);
    if (isTerminalAuthError(error)
      || error instanceof SessionKeyAuthenticationError
      || isUiClientEncryptionRequirementError(error)
      || isUiClientEncryptionRequirementUnavailableError(error)) throw error;
    return { encryptionMode: 'unknown', sessionDataKey: null };
  }
}

export async function resolveScopedSessionDataKey(params: ScopedSessionKeyParams): Promise<Uint8Array | null> {
  const context = await resolveScopedSessionCryptoContext(params);
  return context.encryptionMode === 'e2ee' ? context.sessionDataKey : null;
}

export function resetScopedSessionDataKeyCacheForTests(): void {
  sessionReads.reset();
}
