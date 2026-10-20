import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { encodeBase64 } from "privacy-kit";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { featuresRoutes } from "../features/featuresRoutes";
import { sessionRoutes } from "./sessionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    featuresRoutes(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

describe("session create/load before publisher registration (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-register-sqlite-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: randomBytes(32).toString("hex"),
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it.each(["legacy", "dataKey"] as const)("composes local HTTP create/load, binding publish, cross-device decrypt, resume-key recovery and hostile rejection (%s creator)", async (creatorType) => {
        const app: FastifyInstance = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const secret = Array.from(randomBytes(32));
        const tag = `composed-${randomUUID()}`;
        const metadata = { path: join(harness.baseDir, "synthetic-project"), claudeSessionId: "synthetic-resume-id" };
        const agentState = { controlledByUser: true };
        const otherSecret = Array.from(randomBytes(32));
        const cliRoot = resolve(process.cwd(), "../cli");
        const tsconfigPath = join(harness.baseDir, "cli-source.tsconfig.json");
        // Separate process keeps the CLI's @ alias and disposable home out of the server harness.
        await writeFile(tsconfigPath, JSON.stringify({
            extends: join(cliRoot, "tsconfig.json"),
            compilerOptions: { paths: {
                "@/*": [`./${relative(harness.baseDir, join(cliRoot, "src/*"))}`],
                "@happier-dev/protocol": [`./${relative(harness.baseDir, resolve(process.cwd(), "../../packages/protocol/src/index.ts"))}`],
                "@happier-dev/protocol/*": [`./${relative(harness.baseDir, resolve(process.cwd(), "../../packages/protocol/src/*"))}`],
            } },
        }));

        let replacement: Record<string, unknown> | null = null;
        let replacedResponses = 0;
        let requestedCreateMetadata: string | null = null;
        // Capture the binding-less request metadata so the test can replay it as stale content later.
        // Only the creation POST carries the original key's ciphertext; later loads send fresh
        // candidate-key ciphertext that the stored envelope cannot open.
        app.addHook("preHandler", async (request) => {
            if (request.method === "POST" && request.url === "/v1/sessions" && requestedCreateMetadata === null) {
                const body = request.body as { metadata?: unknown };
                if (body && typeof body.metadata === "string") requestedCreateMetadata = body.metadata;
            }
        });
        // Mutate only serialized transport responses; auth, route handlers and SQLite remain real.
        app.addHook("onSend", async (request, reply, payload) => {
            if (!replacement || reply.statusCode !== 200 || typeof payload !== "string"
                || !/^\/v[12]\/sessions(?:\/[^/]+)?$/.test(request.url)) return payload;
            const body = JSON.parse(payload) as { session?: Record<string, unknown> };
            if (!body.session) return payload;
            replacedResponses += 1;
            return JSON.stringify({ ...body, session: { ...body.session, ...replacement } });
        });
        const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

        const program = `
            import assert from 'node:assert/strict';
            import { randomBytes } from 'node:crypto';
            import tweetnacl from 'tweetnacl';
            import { deriveAccountMachineKeyFromRecoverySecret, openOwnerSessionDataKeyEnvelope,
                sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1,
                sealOwnerSessionDataKeyEnvelope, readSessionKeyBindingV1 } from '@happier-dev/protocol';
            import { fetchSessionById, getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
            import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';
            import { decodeBase64, encodeBase64, decrypt, encrypt } from '@/api/encryption';
            import { configuration } from '@/configuration';

            let input = '';
            for await (const chunk of process.stdin) input += chunk;
            const params = JSON.parse(input);
            assert.equal(configuration.apiServerUrl, params.serverUrl);
            const secret = new Uint8Array(params.secret);
            const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
            const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
            const credentials = { token: params.token, encryption: params.type === 'legacy'
                ? { type: 'legacy', secret } : { type: 'dataKey', machineKey, publicKey } };
            const stripBinding = (record) => {
                const { sessionKeyBindingV1, ...rest } = record;
                return rest;
            };
            try {
                if (params.action === 'resume') {
                    const result = await resolveExistingSessionAttachContext({
                        token: params.token, sessionId: params.sessionId, credentials,
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    });
                    if (!result.ok) throw new Error('Attach failed: ' + result.reason);
                    assert.equal(result.attachPayload.encryptionMode, 'e2ee');
                    assert.equal(result.attachPayload.encryptionVariant, 'dataKey');
                    const key = decodeBase64(result.attachPayload.encryptionKeyBase64);
                    const row = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
                    assert.ok(row);
                    assert.deepEqual(decrypt(key, 'dataKey', decodeBase64(row.metadata)), result.metadata);
                    process.stdout.write(JSON.stringify({ metadata: stripBinding(result.metadata),
                        agentState: decrypt(key, 'dataKey', decodeBase64(row.agentState)),
                        sessionPath: result.sessionPath, vendorResumeId: result.vendorResumeId }));
                } else {
                    const result = await getOrCreateSessionByTag({ credentials, tag: params.tag,
                        metadata: params.metadata, agentState: params.agentState });
                    const row = result.session;
                    // An independently derived paired credential opens what the creating CLI sent.
                    const opened = openOwnerSessionDataKeyEnvelope({ material: { type: 'dataKey', machineKey },
                        sessionTag: params.tag, envelope: decodeBase64(row.dataEncryptionKey) });
                    assert.ok(opened);
                    const dataKey = opened.dataKey;
                    assert.notDeepEqual(dataKey, machineKey);
                    const recovered = { metadata: decrypt(dataKey, 'dataKey', decodeBase64(row.metadata)),
                        agentState: decrypt(dataKey, 'dataKey', decodeBase64(row.agentState)) };
                    const binding = readSessionKeyBindingV1(recovered.metadata);
                    assert.deepEqual(binding, { v: 1, sessionId: row.id, sessionTag: params.tag });
                    const attackerKey = new Uint8Array(randomBytes(32));
                    const forgedMetadata = { path: '/relay-chosen', claudeSessionId: 'relay-chosen' };
                    const anonymous = sealEncryptedDataKeyEnvelopeV1({ dataKey: attackerKey,
                        recipientPublicKey: publicKey, randomBytes });
                    // The new envelope rejects the coherent anonymous forgery outright.
                    assert.equal(openOwnerSessionDataKeyEnvelope({ material: { type: 'dataKey', machineKey },
                        envelope: anonymous }), null);
                    if (params.type === 'dataKey') {
                        // Positive attack control: the legacy box opener still accepts this forgery,
                        // proving coherence; only the owner envelope refuses it.
                        const unsafeKey = openEncryptedDataKeyEnvelopeV1({ envelope: anonymous,
                            recipientSecretKeyOrSeed: machineKey });
                        assert.deepEqual(unsafeKey, attackerKey);
                        assert.deepEqual(decrypt(unsafeKey, 'dataKey',
                            decodeBase64(encodeBase64(encrypt(attackerKey, 'dataKey', forgedMetadata)))), forgedMetadata);
                    }
                    const otherMachineKey = deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(params.otherSecret));
                    const wrongAccountEnvelope = sealOwnerSessionDataKeyEnvelope({
                        material: { type: 'legacy', secret: new Uint8Array(params.otherSecret) },
                        sessionTag: params.tag, dataKey: attackerKey, randomBytes });
                    assert.equal(openOwnerSessionDataKeyEnvelope({ material: { type: 'dataKey', machineKey },
                        envelope: wrongAccountEnvelope }), null);
                    void otherMachineKey;
                    const forged = { dataEncryptionKey: encodeBase64(anonymous),
                        metadata: encodeBase64(encrypt(attackerKey, 'dataKey', forgedMetadata)),
                        agentState: encodeBase64(encrypt(attackerKey, 'dataKey', { controlledByUser: false })),
                        wrongAccountDataEncryptionKey: encodeBase64(wrongAccountEnvelope) };
                    process.stdout.write(JSON.stringify({ ...result, recovered: stripBinding(recovered), forged }));
                }
            } catch (error) {
                process.stdout.write(JSON.stringify({ error: { name: error.name, code: error.code,
                    retryable: error.retryable, message: error.message } }));
            }
        `;
        const runCli = (params: Record<string, unknown>) => new Promise<unknown>((resolveResult, reject) => {
            const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
                cwd: cliRoot,
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
                env: {
                    PATH: process.env.PATH,
                    SystemRoot: process.env.SystemRoot,
                    HOME: harness.baseDir,
                    USERPROFILE: harness.baseDir,
                    TMPDIR: harness.baseDir,
                    NODE_ENV: "test",
                    TSX_TSCONFIG_PATH: tsconfigPath,
                    HAPPIER_HOME_DIR: join(harness.baseDir, `cli-${randomUUID()}`),
                    HAPPIER_SERVER_URL: serverUrl,
                    HAPPIER_WEBAPP_URL: serverUrl,
                    HAPPIER_ENCRYPTION_REQUIREMENT: "require_e2ee",
                    NO_PROXY: "127.0.0.1,localhost",
                },
            }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`CLI source process failed: ${stderr || error.message}`));
                try { resolveResult(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
            });
            child.stdin?.end(JSON.stringify({ token, secret, otherSecret, serverUrl, tag, metadata, agentState, ...params }));
        });
        const created = await runCli({ action: "create", type: creatorType }) as {
            created: boolean; session: { id: string; dataEncryptionKey: string };
            forged: Record<string, string>;
        };
        expect(created).toMatchObject({ created: true, recovered: { metadata, agentState } });
        expect(requestedCreateMetadata).toEqual(expect.any(String));
        const stored = await db.session.findFirstOrThrow({ where: { accountId: account.id, tag } });
        expect(created.session.id).toBe(stored.id);
        expect(created.session.dataEncryptionKey).toBe(encodeBase64(stored.dataEncryptionKey!));
        expect(stored.metadata).not.toContain(metadata.path);
        expect(stored.metadataVersion).toBeGreaterThan(0);

        const pairedType = creatorType === "legacy" ? "dataKey" : "legacy";
        const loaded = await runCli({ action: "load", type: pairedType, metadata: { ignored: true }, agentState: { ignored: true } });
        expect(loaded).toMatchObject({ created: false, session: { id: stored.id }, recovered: { metadata, agentState } });
        const resumed = { metadata, agentState, sessionPath: metadata.path, vendorResumeId: metadata.claudeSessionId };
        expect(await runCli({ action: "resume", type: pairedType, sessionId: stored.id })).toEqual(resumed);

        const neighbor = await runCli({ action: "create", type: pairedType, tag: `${tag}-neighbor` }) as {
            session: { id: string; dataEncryptionKey: string; metadata: string; agentState: string | null };
        };
        expect(neighbor).toMatchObject({ created: true });
        const sibling = await db.session.findFirstOrThrow({ where: { accountId: account.id, tag: `${tag}-neighbor` } });
        const forged = created.forged;
        const transplant = {
            dataEncryptionKey: encodeBase64(sibling.dataEncryptionKey!),
            metadata: sibling.metadata,
            agentState: sibling.agentState,
        };
        const stale = { metadata: requestedCreateMetadata };
        const wrongAccount = {
            dataEncryptionKey: forged.wrongAccountDataEncryptionKey,
            metadata: forged.metadata,
            agentState: forged.agentState,
        };
        const expectedAuthFailure = { error: { code: "SESSION_KEY_AUTHENTICATION_FAILED", retryable: false } };
        for (const attack of [forged, transplant, wrongAccount, { ...transplant, id: sibling.id }]) {
            replacement = attack;
            expect(await runCli({ action: "load", type: pairedType })).toMatchObject(expectedAuthFailure);
            expect(await runCli({ action: "resume", type: pairedType, sessionId: stored.id })).toMatchObject(expectedAuthFailure);
        }
        // A relay replaying the binding-less request metadata cannot mint a binding: strict
        // resume rejects it as retryable pending, and the next load self-heals the row.
        replacement = stale;
        expect(await runCli({ action: "resume", type: pairedType, sessionId: stored.id }))
            .toMatchObject({ error: { code: "SESSION_KEY_BINDING_PENDING", retryable: true } });
        expect(await runCli({ action: "load", type: pairedType })).toMatchObject({
            created: false, session: { id: stored.id }, recovered: { metadata, agentState },
        });
        expect(replacedResponses).toBe(10);
        replacement = null;
        expect(await runCli({ action: "resume", type: pairedType, sessionId: stored.id })).toEqual(resumed);
        const after = await db.session.findUniqueOrThrow({ where: { id: stored.id } });
        expect(after.dataEncryptionKey).toEqual(stored.dataEncryptionKey);
        expect(await db.session.count({ where: { accountId: account.id } })).toBe(2);
    }, 120_000);

    it("ignores unknown create fields, assigns a server id, and stores the opaque key", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `server-id-${randomUUID()}`;
        const key = new Uint8Array([7, 0, 128, 255]);
        const payload = {
            id: randomUUID(),
            tag,
            metadata: "encrypted-metadata",
            agentState: "encrypted-agent-state",
            dataEncryptionKey: encodeBase64(key),
            encryptionMode: "e2ee",
        };

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload,
        });

        expect(response.statusCode).toBe(200);
        const created = response.json().session;
        expect(created.id).not.toBe(payload.id);
        expect(response.json()).toMatchObject({
            resolution: "created",
            session: {
                metadata: payload.metadata,
                agentState: payload.agentState,
                dataEncryptionKey: payload.dataEncryptionKey,
            },
        });
        await expect(db.session.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
            accountId: account.id,
            tag,
            metadata: payload.metadata,
            agentState: payload.agentState,
            dataEncryptionKey: key,
        });
        await expect(db.session.findUnique({ where: { id: payload.id } })).resolves.toBeNull();
    });

    it.each(["unused", "another-account"] as const)("loads the existing tag without replacing its opaque key or content (proposed id: %s)", async (proposedOwner) => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `existing-id-${randomUUID()}`;
        const key = new Uint8Array([0, 17, 128, 255]);
        const existing = await db.session.create({
            data: {
                accountId: account.id,
                tag,
                metadata: "stored-metadata",
                agentState: "stored-agent-state",
                dataEncryptionKey: key,
                active: true,
            },
        });
        if (proposedOwner === "another-account") {
            await db.session.create({
                data: {
                    account: { create: { publicKey: `pk-${randomUUID()}` } },
                    tag,
                    metadata: "unrelated-metadata",
                },
            });
        }

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                id: randomUUID(),
                tag,
                metadata: "replacement-metadata",
                agentState: "replacement-agent-state",
                dataEncryptionKey: encodeBase64(new Uint8Array([7, 1, 2, 3])),
                encryptionMode: "e2ee",
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            resolution: "existing",
            session: {
                id: existing.id,
                metadata: existing.metadata,
                agentState: existing.agentState,
                dataEncryptionKey: encodeBase64(key),
            },
        });
        await expect(db.session.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toEqual(existing);
    });

    it("isolates same-tag sessions across accounts", async () => {
        const app = createTestApp();
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const tag = `isolation-${randomUUID()}`;
        const ownerSession = await db.session.create({
            data: {
                accountId: owner.id,
                tag,
                metadata: "original-owner-metadata",
            },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${await auth.createToken(other.id)}` },
            payload: { tag, metadata: "other-account-metadata", encryptionMode: "e2ee" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            resolution: "created",
            session: { metadata: "other-account-metadata" },
        });
        expect(response.json().session.id).not.toBe(ownerSession.id);
        await expect(db.session.findUniqueOrThrow({ where: { id: ownerSession.id } })).resolves.toEqual(ownerSession);
        await expect(db.session.findFirstOrThrow({ where: { accountId: other.id, tag } })).resolves.toMatchObject({
            metadata: "other-account-metadata",
        });
    });

    it("keeps a created row inactive through a rejected socket and makes exact registration the sole positive transition", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `create-register-${randomUUID()}`;

        const createdResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag, metadata: "{}", encryptionMode: "e2ee" },
        });

        expect(createdResponse.statusCode).toBe(200);
        const created = createdResponse.json();
        expect(created).toMatchObject({
            resolution: "created",
            session: {
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0,
            },
        });
        const sessionId = created.session.id as string;

        const beforeRegistration = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });
        expect(beforeRegistration).toMatchObject({
            active: false,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 0n,
        });

        const listBeforeRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listBeforeRegistration.statusCode).toBe(200);
        expect(listBeforeRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: false,
                runtimeActivityState: "unknown",
            })],
        });

        const presence = createSessionPublisherPresence();
        const socket = {};
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId: `unregistered-${randomUUID()}`, sessionId },
        })).resolves.toEqual({ status: "unregistered" });
        await expect(presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId: `missing-${randomUUID()}`, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual(beforeRegistration);

        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId, data: "encrypted" },
        });
        const registered = await presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");
        if (registered.status !== "registered") throw new Error("expected exact publisher registration");
        expect(registered.committedFence.getTime()).toBeGreaterThan(beforeRegistration.lastActiveAt.getTime());
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
        })).resolves.toMatchObject({ status: "current" });

        const listAfterRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listAfterRegistration.statusCode).toBe(200);
        expect(listAfterRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: true,
                activeAt: registered.committedFence.getTime(),
                runtimeActivityState: "idle",
            })],
        });
    }, 120_000);

    it("clears archive intent on load without asserting reachability or replacing the publisher fence", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `archived-load-${randomUUID()}`;
        const publisherFence = new Date("2026-07-15T08:00:00.000Z");
        const archivedAt = new Date("2026-07-15T09:00:00.000Z");
        const previousMeaningfulActivityAt = new Date("2026-07-15T07:00:00.000Z");
        const key = new Uint8Array([0, 17, 128, 255]);
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag,
                metadata: "{}",
                dataEncryptionKey: key,
                active: false,
                lastActiveAt: publisherFence,
                archivedAt,
                meaningfulActivityAt: previousMeaningfulActivityAt,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 4n,
            },
        });

        const loadedResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                tag,
                metadata: "ignored-for-existing",
                dataEncryptionKey: encodeBase64(new Uint8Array([7, 1, 2, 3])),
                encryptionMode: "e2ee",
            },
        });

        expect(loadedResponse.statusCode).toBe(200);
        expect(loadedResponse.json()).toMatchObject({
            resolution: "existing",
            session: {
                id: session.id,
                dataEncryptionKey: encodeBase64(key),
                active: false,
                activeAt: publisherFence.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityRevision: 4,
            },
        });
        const stored = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                id: true,
                dataEncryptionKey: true,
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                meaningfulActivityAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(stored).toMatchObject({
            id: session.id,
            dataEncryptionKey: key,
            active: false,
            archivedAt: null,
            lastActiveAt: publisherFence,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: 4n,
        });
        if (stored.meaningfulActivityAt === null) {
            throw new Error("expected load to retain a meaningful activity timestamp");
        }
        expect(stored.meaningfulActivityAt.getTime()).toBeGreaterThan(previousMeaningfulActivityAt.getTime());
    }, 120_000);
});
