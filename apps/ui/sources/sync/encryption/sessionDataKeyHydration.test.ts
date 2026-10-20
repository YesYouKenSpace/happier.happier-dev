import { describe, expect, it } from 'vitest';

import { sealSessionDataKeyFixture } from '@/dev/testkit/fixtures/sessionEncryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';
import { createSessionDataKeyHydrationPlan, hydrateSessionDataKeys } from './sessionDataKeyHydration';

describe('session data key hydration', () => {
    it('opens the same account envelope for each row id; row-identity binding is enforced at metadata decrypt', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const dataKey = new Uint8Array(32).fill(9);
        const envelope = sealSessionDataKeyFixture({ encryption, dataKey });
        const sessionDataKeys = new Map<string, Uint8Array>();
        const sessionDataKeyEnvelopes = new Map<string, string>();
        const result = await hydrateSessionDataKeys({
            plan: createSessionDataKeyHydrationPlan({
                sessions: [
                    { id: 'owner', dataEncryptionKey: envelope },
                    { id: 'second', dataEncryptionKey: envelope },
                    { id: 'plain', encryptionMode: 'plain' },
                ],
                sessionDataKeys,
                sessionDataKeyEnvelopes,
            }),
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(result.sessionKeys).toEqual(new Map([['owner', dataKey], ['second', dataKey]]));
        expect(sessionDataKeyEnvelopes).toEqual(new Map([['owner', envelope], ['second', envelope]]));
    });

    it.each(['missing', 'malformed', 'legacy', 'wrong-account', 'tampered'] as const)(
        'rejects %s envelopes and clears a previously usable key', async (kind) => {
            const encryption = await Encryption.create(new Uint8Array(32).fill(7));
            const dataKey = new Uint8Array(32).fill(9);
            const oldEnvelope = sealSessionDataKeyFixture({ encryption, dataKey });
            let envelope: string | null = null;
            if (kind === 'malformed') envelope = 'not-an-envelope';
            if (kind === 'legacy') envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
            if (kind === 'wrong-account') {
                const other = await Encryption.create(new Uint8Array(32).fill(8));
                envelope = sealSessionDataKeyFixture({ encryption: other, dataKey });
            }
            if (kind === 'tampered') {
                const bytes = decodeBase64(oldEnvelope, 'base64');
                bytes[bytes.length - 1] ^= 1;
                envelope = encodeBase64(bytes, 'base64');
            }
            await encryption.initializeSessions(new Map([['owner', dataKey]]));
            const sessionDataKeys = new Map([['owner', dataKey]]);
            const sessionDataKeyEnvelopes = new Map([['owner', oldEnvelope]]);
            const result = await hydrateSessionDataKeys({
                plan: createSessionDataKeyHydrationPlan({
                    sessions: [{ id: 'owner', dataEncryptionKey: envelope }],
                    sessionDataKeys,
                    sessionDataKeyEnvelopes,
                }),
                encryption,
                sessionDataKeys,
                sessionDataKeyEnvelopes,
            });

            expect(result.sessionKeys.size).toBe(0);
            expect(result.sessionEncryptionClears).toContain('owner');
            expect(sessionDataKeys.size).toBe(0);
            expect(sessionDataKeyEnvelopes.size).toBe(0);
            expect(encryption.getSessionEncryption('owner')).toBeNull();
        },
    );

    it('reuses unchanged authenticated keys and replaces rotated keys', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const sessionDataKeys = new Map<string, Uint8Array>();
        const sessionDataKeyEnvelopes = new Map<string, string>();
        for (const dataKey of [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]) {
            const envelope = sealSessionDataKeyFixture({ encryption, dataKey });
            const params = { sessions: [{ id: 'owner', dataEncryptionKey: envelope }], sessionDataKeys, sessionDataKeyEnvelopes };
            const result = await hydrateSessionDataKeys({
                plan: createSessionDataKeyHydrationPlan(params), encryption, sessionDataKeys, sessionDataKeyEnvelopes,
            });
            await encryption.initializeSessions(result.sessionKeys);
            const cached = createSessionDataKeyHydrationPlan(params);
            expect(cached.cachedDataKeyHits).toBe(1);
            const repeated = await hydrateSessionDataKeys({ plan: cached, encryption, sessionDataKeys, sessionDataKeyEnvelopes });
            expect(repeated.sessionKeys.get('owner')).toBe(sessionDataKeys.get('owner'));
            expect(sessionDataKeys.get('owner')).toEqual(dataKey);
        }
    });

    it('does not treat a scoped foreign-account key as authenticated on the active server', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const foreign = await Encryption.create(new Uint8Array(32).fill(8));
        const dataKey = new Uint8Array(32).fill(9);
        const envelope = sealSessionDataKeyFixture({ encryption: foreign, dataKey });
        await encryption.initializeSessions(new Map([['owner', dataKey]]), { serverId: 'foreign-server' });
        const sessionDataKeys = new Map([['owner', dataKey]]);
        const sessionDataKeyEnvelopes = new Map([['owner', envelope]]);
        const result = await hydrateSessionDataKeys({
            plan: createSessionDataKeyHydrationPlan({
                sessions: [{ id: 'owner', dataEncryptionKey: envelope }], sessionDataKeys, sessionDataKeyEnvelopes,
            }),
            encryption, sessionDataKeys, sessionDataKeyEnvelopes, scope: { serverId: 'active-server' },
        });
        expect(result.sessionKeys.size).toBe(0);
        expect(sessionDataKeys.size).toBe(0);
        expect(encryption.getSessionEncryption('owner')).toBeNull();
    });
});
