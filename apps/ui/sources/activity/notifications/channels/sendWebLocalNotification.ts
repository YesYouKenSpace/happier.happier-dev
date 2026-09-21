import { getWebNotificationPermission, isWebNotificationSupported, showWebNotification } from './webNotificationApi';

// Browsers only allow Notification.requestPermission() from a user gesture, and this channel
// runs from a background activity-event listener — so it must never request permission itself,
// only show when the user already granted it (e.g. via a settings screen).
export async function sendWebLocalNotification(params: Readonly<{
    title: string;
    body: string;
}>): Promise<boolean> {
    if (!isWebNotificationSupported()) return false;
    if (getWebNotificationPermission() !== 'granted') return false;

    showWebNotification({ title: params.title, body: params.body });
    return true;
}
