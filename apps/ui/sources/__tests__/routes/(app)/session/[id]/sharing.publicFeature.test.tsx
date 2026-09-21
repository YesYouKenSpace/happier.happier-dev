import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import type { PublicSessionShare } from '@/sync/domains/social/sharingTypes';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

const modalSpies = vi.hoisted(() => ({ show: vi.fn(), update: vi.fn() }));
installSessionRouteCommonModuleMocks({
    storageModule: (importOriginal) => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: modalSpies }).module;
    },
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('posthog-react-native', () => ({ default: class {} }));
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: vi.fn() }));

const existingShare: PublicSessionShare = {
    id: 'share-1', sessionId: 'session-1', token: 'cached-token',
    expiresAt: 1000, maxUses: 10, useCount: 2, isConsentRequired: true,
    createdAt: 0, updatedAt: 0,
};
let publicShare: PublicSessionShare | null;
const requests: Array<{ path: string; method: string }> = [];
let restoreCredentials: () => void;

beforeEach(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED', undefined);
    // The explicit deny isolates the missing UI guard from concurrent changes to the default.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'sharing.public');
    modalSpies.show.mockReset().mockReturnValue('modal-1');
    modalSpies.update.mockReset();
    publicShare = null;
    requests.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        const method = init?.method ?? 'GET';
        requests.push({ path, method });
        if (path === '/v1/auth/ping' || path === '/health') return Response.json({ ok: true });
        if (path === '/v1/features') return Response.json(buildServerFeaturesResponse());
        if (path === '/v1/sessions/session-1/shares') return Response.json({ shares: [] });
        if (path === '/v1/sessions/session-1/public-share') {
            if (method === 'DELETE') publicShare = null;
            return Response.json({ publicShare });
        }
        if (path === '/v1/friends') return Response.json({ friends: [] });
        throw new Error(`Unexpected request: ${method} ${path}`);
    }));
    const { sync } = await import('@/sync/sync');
    const { getStorage } = await import('@/sync/domains/state/storage');
    getStorage().setState({
        isDataReady: true,
        sessions: { 'session-1': createSessionFixture({ encryptionMode: 'plain', accessLevel: 'admin' }) },
    });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { 'sharing.public': true } });
    const previousCredentials = sync.getCredentials();
    // Seed the authenticated singleton without starting unrelated background synchronization.
    Reflect.set(sync, 'credentials', { token: 'test-token', secret: '' });
    restoreCredentials = () => { Reflect.set(sync, 'credentials', previousCredentials); };
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
});

afterEach(() => {
    restoreCredentials?.();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('Session sharing public feature gate', () => {
    it('offers creation after explicit opt-in and server support without creating on load', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED', 'true');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', '');
        const { default: Screen } = await import('@/app/(app)/session/[id]/sharing');
        const screen = await renderScreen(<Screen />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findAllByProps({ title: 'session.sharing.createPublicLink' }).length).toBeGreaterThan(0);
        });

        const createLink = screen.findAllByProps({ title: 'session.sharing.createPublicLink' })[0];
        await act(async () => { createLink.props.onPress(); });
        await vi.waitFor(() => expect(modalSpies.show).toHaveBeenCalled());
        const { component: Dialog, props } = modalSpies.show.mock.calls[0][0];
        const dialog = await renderScreen(<Dialog {...props} onClose={vi.fn()} setChrome={vi.fn()} />);

        expect(dialog.findAllByProps({ title: 'session.sharing.createPublicLink' }).length).toBeGreaterThan(0);
        expect(requests.some(({ method }) => method === 'POST')).toBe(false);
    });

    it.each([false, true])('keeps direct sharing and existing-link deletion available (existing=%s)', async (hasExistingShare) => {
        publicShare = hasExistingShare ? existingShare : null;
        const { default: Screen } = await import('@/app/(app)/session/[id]/sharing');
        const screen = await renderScreen(<Screen />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findAllByProps({ title: 'session.sharing.addShare' }).length).toBeGreaterThan(0);
        });

        expect(screen.findAllByProps({ title: 'session.sharing.createPublicLink' })).toHaveLength(0);
        expect(requests).toContainEqual({ path: '/v1/sessions/session-1/public-share', method: 'GET' });
        expect(requests.some(({ method }) => method === 'POST')).toBe(false);

        if (hasExistingShare) {
            const activeLink = screen.findAllByProps({ title: 'session.sharing.publicLinkActive' })[0];
            await act(async () => { activeLink.props.onPress(); });
            await vi.waitFor(() => expect(modalSpies.show).toHaveBeenCalled());
            const { component: Dialog, props } = modalSpies.show.mock.calls[0][0];
            const dialog = await renderScreen(<Dialog {...props} onClose={vi.fn()} setChrome={vi.fn()} />);

            expect(dialog.findByTestId('public-link-copy')).toBeNull();
            expect(dialog.getTextContent()).not.toContain('cached-token');
            expect(dialog.findAllByProps({ title: 'session.sharing.regeneratePublicLink' })).toHaveLength(0);
            const deleteLink = dialog.findAllByProps({ title: 'session.sharing.deletePublicLink' })[0];
            await act(async () => { await deleteLink.props.onPress(); });

            expect(requests).toContainEqual({ path: '/v1/sessions/session-1/public-share', method: 'DELETE' });
            expect(screen.findAllByProps({ title: 'session.sharing.publicLinkActive' })).toHaveLength(0);
            expect(screen.findAllByProps({ title: 'session.sharing.createPublicLink' })).toHaveLength(0);
        }
    });
});
