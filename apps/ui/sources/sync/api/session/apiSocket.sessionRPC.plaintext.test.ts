import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { buildSession } from '@/sync/engine/pending/pendingQueueV2.testHelpers';

import { apiSocket } from './apiSocket';

const initialState = storage.getState();
const emitWithAck = vi.fn(async () => ({ ok: true, result: { ok: true, value: 123 } }));
const timeout = vi.fn(() => ({ emitWithAck }));
const socket = { emitWithAck, timeout };
const apiInternals = apiSocket as unknown as { socket: typeof socket | null; encryption: Encryption | null };

describe('apiSocket.sessionRPC plaintext sessions', () => {
    beforeEach(async () => {
        storage.setState(initialState, true);
        storage.getState().applySettingsLocal({ clientEncryptionRequirementV1: 'follow_account', clientEncryptionRequirementLocalV1: 'follow_account' });
        storage.getState().applySessions([buildSession({ sessionId: 's1', overrides: { encryptionMode: 'plain' } })]);
        emitWithAck.mockClear();
        timeout.mockClear();
        apiInternals.socket = socket;
        apiInternals.encryption = await Encryption.create(new Uint8Array(32).fill(7));
    });

    afterEach(() => {
        apiInternals.socket = null;
        apiInternals.encryption = null;
        storage.setState(initialState, true);
    });

    it('sends plaintext params when session encryptionMode is plain and session encryption is missing', async () => {
        const response = await apiSocket.sessionRPC('s1', 'ping', { hello: 'world' });
        expect(emitWithAck).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 's1:ping', params: { hello: 'world' } }));
        expect(response).toEqual({ ok: true, value: 123 });
    });

    it('fails closed when encryptionMode is not plain and session encryption is missing', async () => {
        storage.getState().applySessions([buildSession({ sessionId: 's1', overrides: { encryptionMode: 'e2ee' } })]);
        await expect(apiSocket.sessionRPC('s1', 'ping', { hello: 'world' })).rejects.toThrow('Session encryption not found');
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('permits opted-out plaintext mode even if an encryption object exists', async () => {
        await apiInternals.encryption!.initializeSessions(new Map([['s1', new Uint8Array(32).fill(9)]]));
        await expect(apiSocket.sessionRPC('s1', 'ping', { hello: 'world' })).resolves.toEqual({ ok: true, value: 123 });
        expect(emitWithAck).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ params: { hello: 'world' } }));
    });

    it('uses socket ack timeouts when session RPC options provide timeoutMs', async () => {
        await expect(apiSocket.sessionRPC('s1', 'ping', { hello: 'world' }, { timeoutMs: 7500 }))
            .resolves.toEqual({ ok: true, value: 123 });
        expect(timeout).toHaveBeenCalledWith(7500);
        expect(emitWithAck).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 's1:ping', params: { hello: 'world' } }));
    });
});
