import { SessionKeyAuthenticationError, SessionKeyBindingPendingError } from '@happier-dev/protocol';

import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { isClientE2eeRequiredError } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

export function readSessionMetadataForPresentation(
  params: Parameters<typeof tryDecryptSessionMetadata>[0],
): Record<string, unknown> | null {
  try {
    return tryDecryptSessionMetadata(params);
  } catch (error) {
    // Retained inaccessible rows may expose their IDs, never unauthenticated metadata.
    // Binding-pending rows are the short create→patch window; discovery still lists them
    // while selected-session resolution stays strict and retryable.
    if (
      error instanceof SessionKeyAuthenticationError
      || error instanceof SessionKeyBindingPendingError
      || isClientE2eeRequiredError(error)
    ) return null;
    throw error;
  }
}
