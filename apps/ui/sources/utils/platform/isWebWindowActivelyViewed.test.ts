import { afterEach, describe, expect, it } from 'vitest';

import { isWebWindowActivelyViewed } from './isWebWindowActivelyViewed';

// Cast fully to a narrow shape rather than intersecting with `typeof globalThis`: intersecting
// with the ambient DOM `Document` type collapses `unknown` back to that concrete type, which
// rejects both the partial fixture shapes below and the `undefined` no-document case.
type GlobalWithDocument = { document?: unknown };

function getGlobalWithDocument(): GlobalWithDocument {
    return globalThis as unknown as GlobalWithDocument;
}

describe('isWebWindowActivelyViewed', () => {
    const originalDocument = getGlobalWithDocument().document;

    afterEach(() => {
        getGlobalWithDocument().document = originalDocument;
    });

    it.each([
        ['document is undefined', undefined, false],
        ['hidden regardless of focus', { visibilityState: 'hidden', hasFocus: (): boolean => true }, false],
        ['visible and focused', { visibilityState: 'visible', hasFocus: (): boolean => true }, true],
        ['visible but unfocused', { visibilityState: 'visible', hasFocus: (): boolean => false }, false],
        ['visible with no hasFocus implementation', { visibilityState: 'visible' }, true],
    ] as const)('%s -> %s', (_label, document, expected) => {
        getGlobalWithDocument().document = document;

        expect(isWebWindowActivelyViewed()).toBe(expected);
    });
});
