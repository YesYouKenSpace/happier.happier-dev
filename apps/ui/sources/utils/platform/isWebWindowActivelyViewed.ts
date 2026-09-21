export function isWebWindowActivelyViewed(): boolean {
    const doc = (globalThis as unknown as {
        document?: {
            visibilityState?: string;
            hasFocus?: () => boolean;
        };
    }).document;

    // Unlike the Tauri desktop counterpart (always inside its own window), a missing
    // `document` on web means there is no viewable window at all, so treat it as not viewed.
    if (!doc) {
        return false;
    }

    if (doc.visibilityState === 'hidden') {
        return false;
    }

    return doc.hasFocus?.() ?? true;
}
