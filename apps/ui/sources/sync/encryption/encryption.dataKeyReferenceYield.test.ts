import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';
import { sealSessionDataKeyFixture } from '@/dev/testkit/fixtures/sessionEncryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';

/**
 * Counts how many macrotask turns the JS thread got while a batch was running.
 * A reference batch that maps over every item in one synchronous block never
 * releases the thread, so the interval callback cannot run at all.
 */
async function measureThreadTurns<T>(run: () => Promise<T>): Promise<{ value: T; turns: number }> {
    let turns = 0;
    const interval = setInterval(() => {
        turns += 1;
    }, 0);
    try {
        const value = await run();
        return { value, turns };
    } finally {
        clearInterval(interval);
    }
}

describe('Encryption.decryptEncryptionKeys reference path', () => {
    it('opens owner envelopes across credential modes with yielding JS, never the V1 native worker', async () => {
        const owner = await Encryption.create(new Uint8Array(32).fill(7));
        const paired = await Encryption.createFromContentKeyPair({
            publicKey: owner.contentDataKey, machineKey: owner.getContentPrivateKey(),
        });
        const worker = createFakeCryptoWorker();
        const openV1 = vi.fn(worker.decryptDataKeyEnvelopeV1);
        paired.configureNativeCryptoWorker({
            worker: { ...worker, decryptDataKeyEnvelopeV1: openV1 },
            routing: { mode: 'require', minPayloadBytes: 0, minBatchSize: 1 },
        });
        const expected: Array<Uint8Array | null> = [];
        const rows = Array.from({ length: 65 }, (_, index) => {
            const id = `owner-${index}`;
            const dataKey = new Uint8Array(32).fill(index + 1);
            const undecodable = index % 5 === 4;
            expected.push(undecodable ? null : dataKey);
            // Row-id binding is enforced later at metadata decrypt; the batch opener only
            // distinguishes structurally invalid envelopes here.
            if (undecodable) return { id, dataEncryptionKey: 'not-an-envelope' };
            return { id, dataEncryptionKey: sealSessionDataKeyFixture({ encryption: owner, dataKey }) };
        });
        const { value, turns } = await measureThreadTurns(() => paired.decryptSessionEncryptionKeys(rows));
        expect(value).toEqual(expected);
        expect(turns).toBeGreaterThan(0);
        expect(openV1).not.toHaveBeenCalled();
    });

    it('yields the JS thread while opening a large envelope batch and still returns per-item results', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        // Force the JS reference path: this is exactly the state a build with no usable
        // native crypto worker is permanently in.
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });

        // Interleave undecodable envelopes so per-index result mapping is discriminating:
        // an implementation that reorders or drops items cannot pass.
        const envelopes: string[] = [];
        const expected: Array<Uint8Array | null> = [];
        for (let index = 0; index < 50; index += 1) {
            if (index % 5 === 4) {
                envelopes.push('not-an-envelope');
                expected.push(null);
                continue;
            }
            const dataKey = new Uint8Array(32).fill((index % 251) + 1);
            envelopes.push(encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'));
            expected.push(dataKey);
        }

        const { value: decrypted, turns } = await measureThreadTurns(
            () => encryption.decryptEncryptionKeys(envelopes),
        );

        expect(decrypted).toEqual(expected);
        expect(turns).toBeGreaterThan(0);
    });

    it('keeps a small batch on the single synchronous pass', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });

        const dataKey = new Uint8Array(32).fill(9);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');

        const { value: decrypted, turns } = await measureThreadTurns(
            () => encryption.decryptEncryptionKeys([envelope, 'not-an-envelope']),
        );

        expect(decrypted).toEqual([dataKey, null]);
        expect(turns).toBe(0);
    });
});
