import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { QRCode } from '@/components/qr';
import type { PublicSessionShare } from '@/sync/domains/social/sharingTypes';

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async () => true),
}));
const modalMocks = vi.hoisted(() => ({
    alert: vi.fn(),
}));

vi.mock('expo-clipboard', () => clipboardMocks);
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: vi.fn() }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options?.web ?? options?.default,
        },
        Linking: {
            openURL: vi.fn(async () => undefined),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: modalMocks,
    }).module;
});

const existingShare: PublicSessionShare = {
    id: 'share-1',
    sessionId: 'session-1',
    token: 'public-token',
    expiresAt: 1000,
    maxUses: 10,
    useCount: 2,
    isConsentRequired: true,
    createdAt: 0,
    updatedAt: 0,
};

describe('PublicLinkDialog', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alert.mockClear();
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('copies the public link without showing a success modal', async () => {
        const { PublicLinkDialog } = await import('./PublicLinkDialog');

        const screen = await renderScreen(
            <PublicLinkDialog
                publicSharingEnabled={true}
                publicShare={existingShare}
                onCreate={vi.fn()}
                onDelete={vi.fn()}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        await screen.pressByTestIdAsync('public-link-copy');

        expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('/share/public-token');
        expect(modalMocks.alert).not.toHaveBeenCalledWith('common.copied', 'items.copiedToClipboard');
        expect(screen.findHostByTestId('public-link-copy-copied')).not.toBeNull();
    });

    it.each([
        { name: 'no existing link', publicShare: null },
        { name: 'cached token', publicShare: existingShare },
        { name: 'non-recoverable token', publicShare: { ...existingShare, token: null } },
    ])('blocks creation and redistribution with $name when disabled, preserving deletion', async ({ publicShare }) => {
        const { PublicLinkDialog } = await import('./PublicLinkDialog');
        const onCreate = vi.fn();
        const onDelete = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(
            <PublicLinkDialog
                publicSharingEnabled={false}
                publicShare={publicShare}
                onCreate={onCreate}
                onDelete={onDelete}
                onClose={onClose}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.findAllByProps({ title: 'session.sharing.createPublicLink' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'session.sharing.regeneratePublicLink' })).toHaveLength(0);
        expect(screen.findAllByType(QRCode)).toHaveLength(0);
        expect(screen.findByTestId('public-link-copy')).toBeNull();
        expect(screen.findAllByProps({ title: 'session.sharing.linkToken' })).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('public-token');
        expect(screen.getTextContent()).toContain('common.disabled');
        expect(onCreate).not.toHaveBeenCalled();
        expect(clipboardMocks.setStringAsync).not.toHaveBeenCalled();

        if (publicShare) {
            expect(screen.findAllByProps({ title: 'session.sharing.usageCount' }).length).toBeGreaterThan(0);
            expect(screen.findAllByProps({ title: 'session.sharing.expiresOn' }).length).toBeGreaterThan(0);
            const deleteItem = screen.findAllByProps({ title: 'session.sharing.deletePublicLink' })[0];
            await act(async () => { await deleteItem.props.onPress(); });
            expect(onDelete).toHaveBeenCalledOnce();
            expect(onClose).toHaveBeenCalledOnce();
        }
    });

    it('hides an already visible token when the owning screen disables public sharing', async () => {
        const { PublicLinkDialog } = await import('./PublicLinkDialog');
        const props = {
            publicShare: existingShare,
            onCreate: vi.fn(),
            onDelete: vi.fn(),
            onClose: vi.fn(),
            setChrome: vi.fn(),
        };
        const screen = await renderScreen(<PublicLinkDialog {...props} publicSharingEnabled={true} />);
        expect(screen.findByTestId('public-link-copy')).not.toBeNull();

        await screen.update(<PublicLinkDialog {...props} publicSharingEnabled={false} />);

        expect(screen.findByTestId('public-link-copy')).toBeNull();
        expect(screen.findAllByType(QRCode)).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('public-token');
    });
});
