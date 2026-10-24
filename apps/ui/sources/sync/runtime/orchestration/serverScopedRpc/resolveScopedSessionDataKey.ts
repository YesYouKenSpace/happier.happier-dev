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

import { createScopedCacheTokenKeyRegistry } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';
import type { ScopedRpcSessionEncryptionContext } from './serverScopedRpcTypes';

export type ScopedSessionCryptoContext =
  | Readonly<{ encryptionMode: 'plain'; sessionDataKey: null }>
  | Readonly<{ encryptionMode: 'e2ee'; sessionDataKey: Uint8Array }>
  | Readonly<{ encryptionMode: 'unknown'; sessionDataKey: null }>;

function readMaxSessionKeyCacheEntriesFromEnv(): number {
  const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX ?? '').trim();
  if (!raw) return 256;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 256;
  return Math.max(1, Math.min(10_000, parsed));
}

const sessionCryptoContextCache = new Map<string, ScopedSessionCryptoContext>();
const sessionTokenKeys = createScopedCacheTokenKeyRegistry();

function toSessionDataKeyCacheKey(serverId: string, sessionId: string, token: string): string {
  const tokenKey = sessionTokenKeys.getOrCreate(token, readMaxSessionKeyCacheEntriesFromEnv());
  return `${serverId}::${sessionId}::${tokenKey}`;
}

function getSessionCryptoContextFromCache(cacheKey: string): ScopedSessionCryptoContext | undefined {
  const existing = sessionCryptoContextCache.get(cacheKey);
  if (existing === undefined) return undefined;
  // Refresh LRU ordering.
  sessionCryptoContextCache.delete(cacheKey);
  sessionCryptoContextCache.set(cacheKey, existing);
  return existing;
}

function setSessionCryptoContextCache(cacheKey: string, value: ScopedSessionCryptoContext): void {
  sessionCryptoContextCache.set(cacheKey, value);

  const max = readMaxSessionKeyCacheEntriesFromEnv();
  while (sessionCryptoContextCache.size > max) {
    const oldest = sessionCryptoContextCache.keys().next();
    if (oldest.done) break;
    sessionCryptoContextCache.delete(oldest.value);
  }
};

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
  const serverId = String(params.serverId ?? '').trim();
  const token = String(params.token ?? '');
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const cacheKey = toSessionDataKeyCacheKey(serverId, sessionId, token);

  const cached = getSessionCryptoContextFromCache(cacheKey);
  if (cached !== undefined) {
    // The memo key covers server, session and token, but the opener is the caller's
    // encryption instance: only adopt the cached key when this instance actually holds
    // it, so a different account secret never inherits another account's resolution.
    // (The token alone does not determine credentials.)
    if (cached.encryptionMode === 'e2ee'
      && params.encryption.hasSessionEncryptionKey(sessionId, cached.sessionDataKey)) {
      // Keep the caller's Encryption instance settled for follow-up decryption.
      await params.encryption.initializeSessions(new Map([[sessionId, cached.sessionDataKey]]));
      return cached;
    }
    if (cached.encryptionMode !== 'e2ee') {
      params.encryption.removeSessionEncryption(sessionId);
      if (cached.encryptionMode === 'plain') {
        assertScopedUiSessionEncryptionModeAllowed({
          mode: 'plain',
          serverId: params.serverId,
          accountId: parseToken(params.token),
        });
      }
      return cached;
    }
  }

  const context = await resolveUncachedScopedSessionCryptoContext(params, sessionId, timeoutMs);
  // Cache only stable outcomes; transient fetch failures should be retried.
  if (context.encryptionMode !== 'unknown') {
    setSessionCryptoContextCache(cacheKey, context);
  }
  return context;
}

async function resolveUncachedScopedSessionCryptoContext(
  params: ScopedSessionKeyParams,
  sessionId: string,
  timeoutMs: number,
): Promise<ScopedSessionCryptoContext> {
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
  sessionCryptoContextCache.clear();
  sessionReads.reset();
  sessionTokenKeys.reset();
}
