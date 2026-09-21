import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { installPublicShareViewerCommonModuleMocks } from './publicShareViewerTestHelpers';

installPublicShareViewerCommonModuleMocks();

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: vi.fn() }));
vi.mock('posthog-react-native', () => ({ default: class {} }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const requests: Array<{ path: string; method: string }> = [];
let featureResponse: () => Promise<Response>;

beforeEach(async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED', 'true');
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', '');
    requests.length = 0;
    featureResponse = async () => Response.json(buildServerFeaturesResponse());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        requests.push({ path, method: init?.method ?? 'GET' });
        if (path === '/v1/features') return featureResponse();
        if (path === '/v1/public-share/tok-1') {
            return Response.json({
                error: 'consent_required',
                requiresConsent: true,
                sessionId: 'session-1',
                owner: null,
            }, { status: 403 });
        }
        throw new Error(`Unexpected request: ${path}`);
    }));
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const { getStorage } = await import('@/sync/domains/state/storage');
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { 'sharing.public': true } });
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

async function renderViewer() {
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');
    return renderScreen(<AuthProvider initialCredentials={null}><PublicShareViewerScreen /></AuthProvider>);
}

describe('PublicShareViewerScreen feature gate', () => {
    it.each([
        { name: 'default-off client', optIn: undefined, deny: '' },
        { name: 'explicit build deny despite opt-in', optIn: 'true', deny: 'sharing.public' },
        { name: 'server-disabled sharing despite opt-in', optIn: 'true', deny: '', serverEnabled: false },
    ])('blocks token requests for $name', async ({ optIn, deny, serverEnabled }) => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED', optIn);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', deny);
        if (serverEnabled === false) {
            const payload = buildServerFeaturesResponse();
            payload.features.sharing.public.enabled = false;
            featureResponse = async () => Response.json(payload);
        }

        const screen = await renderViewer();

        expect(requests.filter(({ path }) => path.startsWith('/v1/public-share/'))).toEqual([]);
        expect(screen.getTextContent()).toContain('common.disabled');
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'session.sharing.acceptAndView' })).toHaveLength(0);
    });

    it('waits for feature loading before token access, without automatically accepting consent', async () => {
        const pendingFeatures = createDeferred<Response>();
        featureResponse = () => pendingFeatures.promise;

        const screen = await renderViewer();

        expect(requests.filter(({ path }) => path.startsWith('/v1/public-share/'))).toEqual([]);
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' }).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('common.disabled');

        await act(async () => { pendingFeatures.resolve(Response.json(buildServerFeaturesResponse())); });
        await flushHookEffects();

        expect(requests.filter(({ path }) => path.startsWith('/v1/public-share/')))
            .toEqual([{ path: '/v1/public-share/tok-1', method: 'GET' }]);
        expect(screen.findAllByProps({ title: 'session.sharing.acceptAndView' }).length).toBeGreaterThan(0);
        expect(requests.some(({ method }) => method === 'POST')).toBe(false);
    });
});
