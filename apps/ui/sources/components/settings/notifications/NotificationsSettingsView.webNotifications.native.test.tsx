import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    type NotificationChannelV1,
    type NotificationChannelTopicsV1,
    type NotificationsSettingsV1,
} from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Separate file (mirrors SettingsView.connectTerminal.native.test.tsx): `react-native` is mocked
// once per test file and cached across `it()` blocks, so `Platform.OS` cannot be toggled between
// cases in the shared NotificationsSettingsView.test.tsx file — it has to be pinned per file.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createNotificationTopics(overrides: Partial<NotificationChannelTopicsV1> = {}): NotificationChannelTopicsV1 {
    return {
        ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
        ...overrides,
    };
}

function createNotificationsSettings(overrides: Partial<NotificationsSettingsV1> = {}): NotificationsSettingsV1 {
    return {
        ...DEFAULT_NOTIFICATIONS_SETTINGS_V1,
        ...overrides,
    };
}

const settingsState: {
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
} = {
    notificationsSettingsV1: createNotificationsSettings(),
    notificationChannelsV1: [
        {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: true,
            topics: createNotificationTopics(),
            readyIncludeMessageText: true,
            requestIncludeMessageText: true,
        },
    ],
};

const localSettingsState = {
    activityBadgesEnabled: true,
    localNotificationsEnabled: true,
    localNotificationsForegroundBehavior: 'silent',
};

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (options: { ios?: unknown; native?: unknown; default?: unknown }) =>
                    options?.ios ?? options?.native ?? options?.default,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => settingsState,
            useLocalSettings: () => localSettingsState,
        });
    },
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
    useApplyLocalSettings: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('@/activity/notifications/channels/tauriNotificationPlugin', () => ({
    isPermissionGranted: vi.fn(async () => false),
    requestPermission: vi.fn(async () => 'notGranted'),
}));

// Reports supported so the test isolates the Platform.OS gate: the group must stay hidden on
// native even when the seam claims Notification support (a plain Node-shimmed global, not a
// genuine browser boundary).
vi.mock('@/activity/notifications/channels/webNotificationApi', () => ({
    isWebNotificationSupported: () => true,
    getWebNotificationPermission: () => 'default',
    requestWebNotificationPermission: vi.fn(async () => 'granted'),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughComponentMock('ItemList'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: createPassthroughComponentMock('ItemRowActions'),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassthroughComponentMock('Switch'),
}));

describe('NotificationsSettingsView on native platforms', () => {
    it('hides browser notification diagnostics even when the seam reports supported', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.web.title')).toBeNull();
        expect(screen.findRow('settings-notifications-web-permission')).toBeNull();
    });
});
