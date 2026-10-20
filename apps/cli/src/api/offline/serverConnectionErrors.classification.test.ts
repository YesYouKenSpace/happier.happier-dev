import { describe, expect, it, vi } from 'vitest';
import { SessionKeyAuthenticationError } from '@happier-dev/protocol';

import { HttpStatusError, isAuthenticationError, isAuthenticationStatus } from '@/api/client/httpStatusError';

import {
  readNormalizedErrorCode,
  startOfflineReconnection,
} from './serverConnectionErrors';

describe('serverConnectionErrors classification helpers', () => {
  it('stops reconnecting after key authentication fails and preserves its code in the notification', async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn(async () => { throw new SessionKeyAuthenticationError(); });
    const notify = vi.fn();
    const handle = startOfflineReconnection({
      serverUrl: 'http://synthetic.invalid', onReconnected: reconnect, onNotify: notify,
      healthCheck: async () => {}, initialDelayMs: 1, backoffDelayMs: () => 1,
    });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('SESSION_KEY_AUTHENTICATION_FAILED'));
      expect(handle.getSession()).toBeNull();
    } finally {
      handle.cancel();
      vi.useRealTimers();
    }
  });
  it('treats 401 and 403 as terminal authentication statuses', () => {
    expect(isAuthenticationStatus(401)).toBe(true);
    expect(isAuthenticationStatus(403)).toBe(true);
    expect(isAuthenticationStatus(404)).toBe(false);
    expect(isAuthenticationStatus(null)).toBe(false);
  });

  it('treats HttpStatusError and axios-like errors consistently', () => {
    expect(isAuthenticationError(new HttpStatusError(401, 'expired token'))).toBe(true);
    expect(isAuthenticationError({ response: { status: 403 } })).toBe(true);
    expect(isAuthenticationError({ response: { status: 500 } })).toBe(false);
  });

  it('trims and uppercases transport error codes', () => {
    expect(readNormalizedErrorCode({ code: ' etimedout ' })).toBe('ETIMEDOUT');
    expect(readNormalizedErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(readNormalizedErrorCode(new Error('missing code'))).toBe(null);
  });
});
