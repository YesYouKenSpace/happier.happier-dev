import type { Credentials } from '@/persistence';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readCurrentHappierSessionIdFromEnv } from '@/agent/runtime/session/currentSessionIdEnv';

import { createCliActionExecutor } from './createCliActionExecutor';

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: Credentials;
  directSpawnTransport?: DirectSpawnedSessionTransport;
  overrides?: Partial<ActionExecutorDeps>;
  processEnv?: NodeJS.ProcessEnv;
}>): ReturnType<typeof createCliActionExecutor> {
  const callerSessionId = readCurrentHappierSessionIdFromEnv(params.processEnv ?? process.env);

  return createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: callerSessionId ?? 'cli-global',
    currentSessionPermissionAuthority: 'ambient_context',
    ...(params.directSpawnTransport ? { directSpawnTransport: params.directSpawnTransport } : {}),
  }, params.overrides);
}
