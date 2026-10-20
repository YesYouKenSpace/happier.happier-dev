# Browser Local Notifications

Receive session activity alerts from a running Happier browser tab using existing device-local preferences.

**Status:** committed fork source, not a released-feature claim. Origin:
[`432d3af9ea9937050f28679bbbefa8d5e6e05988`](https://github.com/yesyoukenspace/happier.happier-dev/commit/432d3af9ea9937050f28679bbbefa8d5e6e05988).
Comparison basis: cached upstream `dev` at
[`6809131923b2fa434690dd4223762f40f7fab97a`](https://github.com/happier-dev/happier/commit/6809131923b2fa434690dd4223762f40f7fab97a).
No published artifact or browser delivery was verified for this page.

## Fork Difference

Upstream already had local activity events, device settings, content formatting, Tauri desktop notifications,
and native Expo local notifications; its [runtime skipped ordinary web delivery](https://github.com/happier-dev/happier/blob/6809131923b2fa434690dd4223762f40f7fab97a/apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.tsx#L115).
This fork adds a browser delivery adapter, a permission row, and browser focus-aware same-session suppression.
It does not introduce a new notification topic or replace upstream settings.

The [app shell mounts `ActivityLocalNotificationRuntime`](../../apps/ui/sources/app/%28app%29/_layout.tsx#L192).
That [runtime selects channels](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.tsx#L114):
Tauri first, ordinary web second, native Expo otherwise. Tauri also reports `Platform.OS === 'web'`,
but keeps its existing desktop channel and permission UI rather than using the browser adapter.

## Enable Notifications

Use a browser supporting the page-level `Notification` constructor in a secure context, normally HTTPS.
[MDN documents secure-context and user-permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#notifications_require_user_permission).
Mobile-browser support is limited; see [Browser Limits](#browser-limits).

1. Open the fork web app and sign in. Open **Settings > Notifications** through the [settings entry](../../apps/ui/sources/components/settings/SettingsBelowFoldSections.tsx#L326), which reaches the [notifications route](../../apps/ui/sources/app/%28app%29/settings/notifications.tsx).
2. Under **Device notifications**, leave **Enabled** on and choose **Ready**, **Permission requests**, and **Action requests** as needed. Review both preview switches before granting permission.
3. Under **Browser notifications**, press **Browser notification permission**, then allow notifications in the browser prompt. The row stops being actionable once permission is granted.
4. Keep the tab open and running. For a manual check, leave the target session or switch away from the tab, then trigger a ready event or a new request. Open the session manually to respond.

These controls come from [`NotificationsSettingsView`](../../apps/ui/sources/components/settings/notifications/NotificationsSettingsView.tsx#L416).
Names match [English notification labels](../../apps/ui/sources/text/translations/en.ts#L3309) and [`common.enabled`](../../apps/ui/sources/text/translations/en.ts#L1117).
The browser group appears only on non-Tauri web when [`isWebNotificationSupported`](../../apps/ui/sources/activity/notifications/channels/webNotificationApi.ts#L18)
finds a `Notification` global; this is an API-presence check, not proof of successful delivery.

## Defaults And Controls

All six existing device-local booleans default to `true` in the
[local settings registry](../../apps/ui/sources/sync/domains/settings/registry/local/localSettingDefinitions.ts#L305):

- **Enabled**: `localNotificationsEnabled`, the master switch.
- **Ready**: `localNotificationsShowReady`.
- **Ready message previews**: `localNotificationsShowReadyMessageText`.
- **Request previews**: `localNotificationsShowRequestMessageText`.
- **Permission requests**: `localNotificationsShowPendingPermissionRequests`.
- **Action requests**: `localNotificationsShowPendingUserActionRequests`.

[`localSettingsParse`](../../apps/ui/sources/sync/domains/settings/localSettings.ts#L48) fills missing values from these defaults;
existing explicit values remain effective. Browser permission is separate and comes from the browser's current site permission.
Enabled defaults do not grant permission or cause an automatic prompt.
[`shouldNotifyForEvent`](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.tsx#L56)
uses local switches, not the account's **Push notifications**, **Types**, or webhook controls.

**In-app notifications** defaults to **Full** (`localNotificationsForegroundBehavior: 'full'`), but
**Full**, **Silent**, and **Off** do **not** control this browser channel. The
[Expo foreground handler](../../apps/ui/sources/app/_layout.tsx#L301) consumes that preference;
the browser runtime does not, and [`showWebNotification`](../../apps/ui/sources/activity/notifications/channels/webNotificationApi.ts#L33)
passes only title and body. No browser sound override is sent; [MDN describes the default device behavior](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification#silent).

## Triggers And Content

- Ready events reach the shared bus from [`Sync.applyMessages`](../../apps/ui/sources/sync/sync.ts#L7729). The existing [direct-session transcript path](../../apps/ui/sources/sync/sync.ts#L5928) also emits ready activity for changed assistant text when no ready event was found; this is not a new browser-specific completion detector.
- New permission/action requests reach the bus from [`handleUpdateContainer`](../../apps/ui/sources/sync/engine/socket/socket.ts#L1678) after agent-state hydration. [`deriveNewAgentRequests`](../../apps/ui/sources/sync/domains/permissions/deriveNewAgentRequests.ts#L29) selects request IDs absent from the previous request map.
- These are the two event shapes in [`ActivityLocalNotificationEvent`](../../apps/ui/sources/activity/notifications/runtime/activityLocalNotificationBus.ts#L4), not notifications for every message, unread badge, or friend request.

[`buildActivityLocalNotificationContent`](../../apps/ui/sources/activity/notifications/buildActivityLocalNotificationContent.ts#L61)
owns content for the shared local activity channels. Title uses nonempty `session.metadata.summary.text`, otherwise **Session**.
Ready previews use the latest assistant-text message among messages supplied with the event, not a separate full-transcript lookup;
[`buildReadyNotificationContent`](../../packages/protocol/src/push/readyNotificationContent.ts#L12) normalizes whitespace.
Disabled or unavailable ready previews produce **Turn finished. Open the session to continue.**

With request previews enabled, [`summarizeToolInputForNotification`](../../packages/protocol/src/activity/agentRequestNotificationContent.ts#L31)
formats supported command/path details, explanations, questions and options, plans, history-import context, URLs, or search queries.
Disabled previews or unavailable details produce **Approval required.** or **This session needs your input.**
These fallback labels come from [English activity strings](../../apps/ui/sources/text/translations/en.ts#L3520).
Both preview switches default on: body text is passed to the browser/OS notification surface.
The [Request previews subtitle](../../apps/ui/sources/text/translations/en.ts#L3318) warns that details may appear on the lock screen.
Turning previews off removes those body details, **not the session title**; disable **Device notifications > Enabled** to stop this channel.

## Focus And Clicks

[`shouldSuppressSameSessionNotification`](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.tsx#L75)
suppresses a browser alert only when its session matches the actively viewed session and
[`isWebWindowActivelyViewed`](../../apps/ui/sources/utils/platform/isWebWindowActivelyViewed.ts#L1) reports the page actively viewed:
not hidden, with document focus. A hidden or unfocused tab can notify for that same session;
a different session can notify even while the tab is focused, subject to switches and permission.

The [browser send branch](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.tsx#L123)
omits the content builder's session/server/request routing data. `showWebNotification` installs no click handler,
navigation URL, or approval/answer actions. [MDN's default click behavior](https://developer.mozilla.org/en-US/docs/Web/API/Notification/click_event)
focuses the notification's browsing context; this fork does **not** route that click to the target session or switch servers.

## Browser Limits

- Permission diagnostics expose `default`, `requesting`, `granted`, and `denied`. [`useWebNotificationPermissionDiagnostics`](../../apps/ui/sources/components/settings/notifications/useWebNotificationPermissionDiagnostics.ts#L26) reads on mount/support changes and after permission requests, not browser-settings change events. Reopen the screen after changing site permission externally; request errors reread permission rather than showing a dedicated error state.
- Denied permission uses the [English instruction](../../apps/ui/sources/text/translations/en.ts#L3341) to allow notifications in browser settings. [`sendWebLocalNotification`](../../apps/ui/sources/activity/notifications/channels/sendWebLocalNotification.ts#L6) sends only when permission is `granted`; otherwise it returns `false` without prompting. The live [event bus](../../apps/ui/sources/activity/notifications/runtime/activityLocalNotificationBus.ts#L21) has no notification queue to replay skipped events after permission is granted.
- This channel calls `new Notification(title, { body })` from the running page. It adds no service-worker notification or Web Push subscription/delivery path. New alerts require the page runtime to receive activity; closing the tab is not supported background delivery. [MDN distinguishes page-bound and persistent service-worker notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#persistent_and_non-persistent_notifications).
- [MDN warns that the constructor throws on nearly all mobile browsers](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification#description). Presence of the global, a granted row, or installing the web app does not establish mobile delivery support. No service-worker fallback exists in this adapter.
- Constructor failures reach [`fireAndForget`](../../apps/ui/sources/utils/system/fireAndForget.ts#L7) with tag `ActivityLocalNotificationRuntime.sendWebLocalNotification` and log to the console. There is no delivery receipt or fallback UI; granted permission is not delivery confirmation.

## Existing Coverage

Source tests inspected, **not executed for this documentation lane**:

- [`sendWebLocalNotification.test.ts`](../../apps/ui/sources/activity/notifications/channels/sendWebLocalNotification.test.ts#L32) and [`webNotificationApi.test.ts`](../../apps/ui/sources/activity/notifications/channels/webNotificationApi.test.ts#L37): unsupported API, permission states, no sender-side prompt, and title/body construction.
- [`ActivityLocalNotificationRuntime.test.tsx`](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.test.tsx#L292): web dispatch, master-off suppression, and same-session focus gating with mocked channel/focus seams; [`isWebWindowActivelyViewed.test.ts`](../../apps/ui/sources/utils/platform/isWebWindowActivelyViewed.test.ts#L21) checks document visibility/focus separately.
- [`NotificationsSettingsView.test.tsx`](../../apps/ui/sources/components/settings/notifications/NotificationsSettingsView.test.tsx#L357), [native settings test](../../apps/ui/sources/components/settings/notifications/NotificationsSettingsView.webNotifications.native.test.tsx#L130), and [diagnostics hook test](../../apps/ui/sources/components/settings/notifications/useWebNotificationPermissionDiagnostics.test.ts#L17): visibility gates, permission action, status mapping, and in-flight requests.
- [Content tests](../../apps/ui/sources/activity/notifications/buildActivityLocalNotificationContent.test.ts#L15), [local-setting subscription tests](../../apps/ui/sources/activity/notifications/runtime/ActivityLocalNotificationRuntime.localSettings.test.tsx#L64), and [default-setting assertions](../../apps/ui/sources/sync/domains/settings/localSettings.test.ts#L26): previews, generic fallbacks, runtime privacy updates, and defaults. These are shared-owner tests, not browser end-to-end coverage.

Browser/OS delivery, permission prompts, click focus, suspended tabs, mobile behavior, and lock-screen presentation
remain live-QA gaps. Do not turn these source tests into a browser support matrix or a release certification.

## Related

- [Fork policy and index](README.md)
- [Upstream push setup](../../apps/docs/content/docs/extras/notifications-setup.mdx) and [notification routing](../../apps/docs/content/docs/extras/notifications-routing.mdx): separate push/mobile flows; their session-routing and action-button behavior does not apply to this browser adapter.
