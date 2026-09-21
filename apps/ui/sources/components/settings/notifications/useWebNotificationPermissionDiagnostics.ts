import * as React from 'react';

import {
    getWebNotificationPermission,
    requestWebNotificationPermission,
} from '@/activity/notifications/channels/webNotificationApi';

export type WebNotificationPermissionDiagnosticsStatus =
    | 'granted'
    | 'denied'
    | 'default'
    | 'requesting';

// The seam's 'unsupported' state collapses into 'default': callers only invoke this hook with
// `supported: true` once `isWebNotificationSupported()` already confirmed the browser has the
// Notification API, so a runtime 'unsupported' read here is defensive, not an expected path.
function toDiagnosticsStatus(permission: ReturnType<typeof getWebNotificationPermission>): WebNotificationPermissionDiagnosticsStatus {
    return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

function readStatus(supported: boolean): WebNotificationPermissionDiagnosticsStatus {
    if (!supported) return 'default';
    return toDiagnosticsStatus(getWebNotificationPermission());
}

export function useWebNotificationPermissionDiagnostics(supported: boolean): Readonly<{
    status: WebNotificationPermissionDiagnosticsStatus;
    requestPermission: () => Promise<void>;
}> {
    const [status, setStatus] = React.useState<WebNotificationPermissionDiagnosticsStatus>(
        () => readStatus(supported),
    );

    React.useEffect(() => {
        setStatus(readStatus(supported));
    }, [supported]);

    const requestPermission = React.useCallback(async () => {
        if (!supported || status === 'requesting') return;

        setStatus('requesting');
        try {
            const next = await requestWebNotificationPermission();
            setStatus(toDiagnosticsStatus(next));
        } catch {
            setStatus(readStatus(supported));
        }
    }, [status, supported]);

    return { status, requestPermission };
}
