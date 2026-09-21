import { Modal } from '@/modal';
import { t } from '@/text';

import type { CustomModalInjectedProps } from '@/modal';
import type { PublicLinkDialogProps } from './components/PublicLinkDialog';

export async function openPublicLinkDialog(params: Readonly<PublicLinkDialogProps>): Promise<string> {
    const { PublicLinkDialog } = await import('./components/PublicLinkDialog');
    const modalId = Modal.show({
        component: PublicLinkDialog,
        props: {
            publicShare: params.publicShare,
            publicSharingEnabled: params.publicSharingEnabled,
            onCreate: async (options) => {
                const createdShare = await Promise.resolve(params.onCreate(options));
                if (createdShare) {
                    Modal.update<PublicLinkDialogProps & CustomModalInjectedProps>(modalId, {
                        publicShare: createdShare,
                    });
                }
            },
            onDelete: params.onDelete,
        },
        chrome: {
            kind: 'card',
            title: t('session.sharing.publicLink'),
            testID: 'public-link-dialog',
            layout: 'fill',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return modalId;
}
