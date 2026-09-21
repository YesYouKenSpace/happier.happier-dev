import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import type { WebNotificationPermissionState } from '@/activity/notifications/channels/webNotificationApi';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getWebNotificationPermissionMock = vi.hoisted(() => vi.fn<() => WebNotificationPermissionState>());
const requestWebNotificationPermissionMock = vi.hoisted(() => vi.fn<() => Promise<WebNotificationPermissionState>>());

vi.mock('@/activity/notifications/channels/webNotificationApi', () => ({
    getWebNotificationPermission: getWebNotificationPermissionMock,
    requestWebNotificationPermission: requestWebNotificationPermissionMock,
}));

describe('useWebNotificationPermissionDiagnostics', () => {
    beforeEach(() => {
        getWebNotificationPermissionMock.mockReset();
        requestWebNotificationPermissionMock.mockReset();
    });

    it.each([
        ['granted', 'granted'],
        ['denied', 'denied'],
        ['default', 'default'],
        ['unsupported', 'default'],
    ] as const)('maps seam permission %s to status %s when supported', async (seamPermission, expectedStatus) => {
        getWebNotificationPermissionMock.mockReturnValue(seamPermission);
        const { useWebNotificationPermissionDiagnostics } = await import('./useWebNotificationPermissionDiagnostics');

        const hook = await renderHook(() => useWebNotificationPermissionDiagnostics(true));

        expect(hook.getCurrent().status).toBe(expectedStatus);
        expect(getWebNotificationPermissionMock).toHaveBeenCalled();
    });

    it('reports default status and never reads the seam when not supported', async () => {
        getWebNotificationPermissionMock.mockReturnValue('granted');
        const { useWebNotificationPermissionDiagnostics } = await import('./useWebNotificationPermissionDiagnostics');

        const hook = await renderHook(() => useWebNotificationPermissionDiagnostics(false));

        expect(hook.getCurrent().status).toBe('default');
        expect(getWebNotificationPermissionMock).not.toHaveBeenCalled();
    });

    it('exposes an in-flight requesting status while the browser permission prompt is open, then resolves', async () => {
        getWebNotificationPermissionMock.mockReturnValue('default');
        const deferred = createDeferred<WebNotificationPermissionState>();
        requestWebNotificationPermissionMock.mockReturnValue(deferred.promise);
        const { useWebNotificationPermissionDiagnostics } = await import('./useWebNotificationPermissionDiagnostics');

        const hook = await renderHook(() => useWebNotificationPermissionDiagnostics(true));
        expect(hook.getCurrent().status).toBe('default');

        let requestPromise!: Promise<void>;
        await act(async () => {
            requestPromise = hook.getCurrent().requestPermission();
        });
        expect(hook.getCurrent().status).toBe('requesting');

        await act(async () => {
            deferred.resolve('granted');
            await requestPromise;
        });

        expect(hook.getCurrent().status).toBe('granted');
        expect(requestWebNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });

    it('ignores a second request while one is already in flight', async () => {
        getWebNotificationPermissionMock.mockReturnValue('default');
        const deferred = createDeferred<WebNotificationPermissionState>();
        requestWebNotificationPermissionMock.mockReturnValue(deferred.promise);
        const { useWebNotificationPermissionDiagnostics } = await import('./useWebNotificationPermissionDiagnostics');

        const hook = await renderHook(() => useWebNotificationPermissionDiagnostics(true));

        await act(async () => {
            void hook.getCurrent().requestPermission();
        });
        await act(async () => {
            void hook.getCurrent().requestPermission();
        });

        expect(requestWebNotificationPermissionMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            deferred.resolve('granted');
        });
    });

    it('never calls the seam to request permission when not supported', async () => {
        const { useWebNotificationPermissionDiagnostics } = await import('./useWebNotificationPermissionDiagnostics');
        const hook = await renderHook(() => useWebNotificationPermissionDiagnostics(false));

        await act(async () => {
            await hook.getCurrent().requestPermission();
        });

        expect(requestWebNotificationPermissionMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().status).toBe('default');
    });
});
