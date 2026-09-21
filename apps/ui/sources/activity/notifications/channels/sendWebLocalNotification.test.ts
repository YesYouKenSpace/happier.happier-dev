import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendWebLocalNotification } from './sendWebLocalNotification';

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

describe('sendWebLocalNotification', () => {
    const originalNotification = getGlobalWithNotification().Notification;

    afterEach(() => {
        getGlobalWithNotification().Notification = originalNotification;
    });

    it('returns false when Notification is unsupported', async () => {
        delete getGlobalWithNotification().Notification;

        await expect(sendWebLocalNotification({ title: 'Title', body: 'Body' })).resolves.toBe(false);
    });

    it.each([
        ['default', false],
        ['denied', false],
        ['granted', true],
    ] as const)('when permission is %s, send resolves %s and never requests permission', async (permission, expected) => {
        const { requestPermission, constructorSpy } = installFakeNotification(permission);

        const sent = await sendWebLocalNotification({ title: 'Session ready', body: 'Turn finished.' });

        expect(sent).toBe(expected);
        // Browsers only allow requestPermission() from a user gesture; this channel runs from a
        // background event listener and must never trigger the permission prompt itself.
        expect(requestPermission).not.toHaveBeenCalled();
        if (expected) {
            expect(constructorSpy).toHaveBeenCalledWith('Session ready', { body: 'Turn finished.' });
        } else {
            expect(constructorSpy).not.toHaveBeenCalled();
        }
    });
});
