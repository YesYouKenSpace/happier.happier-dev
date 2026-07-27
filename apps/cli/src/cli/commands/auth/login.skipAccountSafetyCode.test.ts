import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials, Settings } from '@/persistence';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';

const authAndSetupMachineIfNeededMock = vi.hoisted(() =>
  vi.fn(async (_opts?: { skipAccountSafetyCode?: boolean }) => ({
    machineId: 'm1',
    credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
  })),
);
const readCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>(async () => null));
const readSettingsMock = vi.hoisted(() => vi.fn<() => Promise<Partial<Settings>>>(async () => ({})));
const clearCredentialsMock = vi.hoisted(() => vi.fn(async () => {}));
const clearMachineIdMock = vi.hoisted(() => vi.fn(async () => {}));
const stopDaemonMock = vi.hoisted(() => vi.fn(async () => {}));
const validateStoredAuthTokenAgainstActiveServerMock = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<ActiveServerStoredTokenValidationResult>>(async () => ({ state: 'valid', httpStatus: 200 })),
);

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: (opts?: { skipAccountSafetyCode?: boolean }) => authAndSetupMachineIfNeededMock(opts),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) => validateStoredAuthTokenAgainstActiveServerMock(token),
}));

vi.mock('@/server/serverSelection', () => ({
  applyServerSelectionFromArgs: async (args: string[]) => args,
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
  clearCredentials: () => clearCredentialsMock(),
  clearMachineId: () => clearMachineIdMock(),
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

describe('happier auth login --skip-account-safety-code', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    authAndSetupMachineIfNeededMock.mockReset();
    authAndSetupMachineIfNeededMock.mockResolvedValue({
      machineId: 'm1',
      credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue(null);
    readSettingsMock.mockReset();
    readSettingsMock.mockResolvedValue({});
    clearCredentialsMock.mockReset();
    clearMachineIdMock.mockReset();
    stopDaemonMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    vi.resetModules();
  });

  it('forwards skipAccountSafetyCode: true and warns the user when the flag is present', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--skip-account-safety-code']);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ skipAccountSafetyCode: true });
      const out = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n').toLowerCase();
      expect(out).toContain('skip');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('forwards skipAccountSafetyCode: false when the flag is absent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ skipAccountSafetyCode: false });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
