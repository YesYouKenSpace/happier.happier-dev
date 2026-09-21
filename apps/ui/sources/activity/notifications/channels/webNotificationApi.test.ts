import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    getWebNotificationPermission,
    isWebNotificationSupported,
    requestWebNotificationPermission,
    showWebNotification,
} from './webNotificationApi';

// Cast fully to a narrow shape rather than intersecting with `typeof globalThis`: intersecting
// with the ambient DOM `Notification` type collapses `unknown` back to that concrete, non-optional
// type (`T & unknown` is `T`), which blocks both fake-class assignment and the `delete` below.
type GlobalWithNotification = { Notification?: unknown };

function getGlobalWithNotification(): GlobalWithNotification {
    return globalThis as unknown as GlobalWithNotification;
}

type FakeNotificationPermission = 'default' | 'granted' | 'denied';

function installFakeNotification(permission: FakeNotificationPermission) {
    const requestPermission = vi.fn(async () => permission);
    const constructorSpy = vi.fn();

    class FakeNotification {
        static permission = permission;
        static requestPermission = requestPermission;
        constructor(title: string, options?: { body?: string }) {
            constructorSpy(title, options);
        }
    }

    getGlobalWithNotification().Notification = FakeNotification;
    return { requestPermission, constructorSpy };
}

describe('webNotificationApi', () => {
    const originalNotification = getGlobalWithNotification().Notification;

    afterEach(() => {
        getGlobalWithNotification().Notification = originalNotification;
    });

    describe('when the Notification global is absent', () => {
        it('reports unsupported everywhere', async () => {
            delete getGlobalWithNotification().Notification;

            expect(isWebNotificationSupported()).toBe(false);
            expect(getWebNotificationPermission()).toBe('unsupported');
            await expect(requestWebNotificationPermission()).resolves.toBe('unsupported');
        });

        it('does not construct a notification', () => {
            delete getGlobalWithNotification().Notification;

            expect(() => showWebNotification({ title: 'Title', body: 'Body' })).not.toThrow();
        });
    });

    it.each([
        ['default'],
        ['granted'],
        ['denied'],
    ] as const)('reports permission %s when supported', (permission) => {
        installFakeNotification(permission);

        expect(isWebNotificationSupported()).toBe(true);
        expect(getWebNotificationPermission()).toBe(permission);
    });

    it('resolves the permission requested from the boundary', async () => {
        const { requestPermission } = installFakeNotification('granted');

        await expect(requestWebNotificationPermission()).resolves.toBe('granted');
        expect(requestPermission).toHaveBeenCalledTimes(1);
    });

    it('constructs a Notification with the given title and body when supported', () => {
        const { constructorSpy } = installFakeNotification('granted');

        showWebNotification({ title: 'Session ready', body: 'Turn finished.' });

        expect(constructorSpy).toHaveBeenCalledWith('Session ready', { body: 'Turn finished.' });
    });
});
