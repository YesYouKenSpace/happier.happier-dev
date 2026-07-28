import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withAndroidReleaseShrinker.js');

describe('withAndroidReleaseShrinker', () => {
    it('is a function (config plugin)', () => {
        expect(typeof plugin).toBe('function');
    });

    it('upserts proguard + shrink resources gradle properties when enabled', () => {
        const apply = plugin.applyAndroidReleaseShrinkerSettingsToGradleProperties as (
            props: any[],
            options: {
                enableMinifyInReleaseBuilds?: boolean;
                enableShrinkResourcesInReleaseBuilds?: boolean;
                gradleJvmArgs?: string;
            }
        ) => any[];
        const props: any[] = [];

        apply(props, {
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            gradleJvmArgs: '-Xmx4096m',
        });
        expect(props).toEqual([
            { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' },
            { type: 'property', key: 'android.enableShrinkResourcesInReleaseBuilds', value: 'true' },
            { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4096m' },
        ]);
    });

    it('throws if shrink resources is enabled without proguard', () => {
        const apply = plugin.applyAndroidReleaseShrinkerSettingsToGradleProperties as (
            props: any[],
            options: { enableMinifyInReleaseBuilds?: boolean; enableShrinkResourcesInReleaseBuilds?: boolean }
        ) => any[];
        const props: any[] = [];

        expect(() => apply(props, { enableShrinkResourcesInReleaseBuilds: true })).toThrow(
            /requires `enableMinifyInReleaseBuilds`/i
        );
    });

    it('writes only org.gradle.jvmargs when minify/shrink are off (debug-APK heap path)', () => {
        const apply = plugin.applyAndroidReleaseShrinkerSettingsToGradleProperties as (
            props: any[],
            options: { gradleJvmArgs?: string }
        ) => any[];
        const props: any[] = [];

        apply(props, { gradleJvmArgs: '-Xmx6144m -XX:MaxMetaspaceSize=1024m' });
        expect(props).toEqual([
            { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx6144m -XX:MaxMetaspaceSize=1024m' },
        ]);
    });
});

describe('resolveGradlePropertiesPluginProps', () => {
    const resolve = plugin.resolveGradlePropertiesPluginProps as (
        options: {
            enableMinifyInReleaseBuilds?: boolean;
            enableShrinkResourcesInReleaseBuilds?: boolean;
            gradleJvmArgs?: string;
        }
    ) => Record<string, unknown> | null;

    it('returns null when no minify/shrink/jvmargs knob is requested', () => {
        expect(resolve({})).toBeNull();
        expect(resolve({ gradleJvmArgs: '   ' })).toBeNull();
    });

    it('activates on gradleJvmArgs alone without enabling minify/shrink', () => {
        expect(resolve({ gradleJvmArgs: '  -Xmx6144m -XX:MaxMetaspaceSize=1024m  ' })).toEqual({
            enableMinifyInReleaseBuilds: false,
            enableShrinkResourcesInReleaseBuilds: false,
            gradleJvmArgs: '-Xmx6144m -XX:MaxMetaspaceSize=1024m',
        });
    });

    it('carries minify/shrink flags alongside jvmargs when enabled', () => {
        expect(
            resolve({
                enableMinifyInReleaseBuilds: true,
                enableShrinkResourcesInReleaseBuilds: true,
                gradleJvmArgs: '-Xmx4096m',
            })
        ).toEqual({
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            gradleJvmArgs: '-Xmx4096m',
        });
    });

    it('activates for minify with no jvmargs and omits the jvmargs key', () => {
        expect(resolve({ enableMinifyInReleaseBuilds: true })).toEqual({
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: false,
        });
    });
});
