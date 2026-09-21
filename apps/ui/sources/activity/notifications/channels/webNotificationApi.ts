// Thin wrapper over the browser `Notification` global — the genuine system boundary.
// The global is read lazily inside each function (never captured at module load) so it
// stays absent on SSR/React Native and so tests can swap `globalThis.Notification` per case.

export type WebNotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

interface WebNotificationGlobal {
    readonly permission: 'default' | 'granted' | 'denied';
    requestPermission: () => Promise<'default' | 'granted' | 'denied'>;
    new (title: string, options?: Readonly<{ body?: string }>): unknown;
}

function readWebNotificationGlobal(): WebNotificationGlobal | undefined {
    const value = (globalThis as unknown as { Notification?: unknown }).Notification;
    return typeof value === 'undefined' ? undefined : value as WebNotificationGlobal;
}

export function isWebNotificationSupported(): boolean {
    return typeof (globalThis as unknown as { Notification?: unknown }).Notification !== 'undefined';
}

export function getWebNotificationPermission(): WebNotificationPermissionState {
    const notificationGlobal = readWebNotificationGlobal();
    return notificationGlobal ? notificationGlobal.permission : 'unsupported';
}

export async function requestWebNotificationPermission(): Promise<WebNotificationPermissionState> {
    const notificationGlobal = readWebNotificationGlobal();
    if (!notificationGlobal) return 'unsupported';
    return await notificationGlobal.requestPermission();
}

export function showWebNotification(params: Readonly<{ title: string; body: string }>): void {
    const notificationGlobal = readWebNotificationGlobal();
    if (!notificationGlobal) return;
    new notificationGlobal(params.title, { body: params.body });
}
