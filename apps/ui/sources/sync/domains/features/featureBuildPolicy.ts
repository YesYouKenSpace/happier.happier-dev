import {
    evaluateFeatureBuildPolicy,
    parseBooleanEnv,
    resolveEmbeddedFeaturePolicyEnv,
    resolveFeatureBuildPolicyFromEnvOrEmbedded,
    type FeatureBuildPolicy,
    type FeatureBuildPolicyEvaluation,
    type FeatureId,
} from '@happier-dev/protocol';

let cachedBuildPolicy: FeatureBuildPolicy | null = null;
let cachedBuildPolicyKey: string | null = null;

function resolveBuildPolicyFromEnv(): FeatureBuildPolicy {
    const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV) ?? undefined;
    const allowRaw = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
    const denyRaw = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    const publicSharingEnabled = parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED, false);
    const key = `${embeddedEnv ?? ''}::${allowRaw ?? ''}::${denyRaw ?? ''}::${publicSharingEnabled}`;

    if (cachedBuildPolicy && cachedBuildPolicyKey === key) {
        return cachedBuildPolicy;
    }

    const next = resolveFeatureBuildPolicyFromEnvOrEmbedded({
        embeddedEnv,
        // UI bundles must only read build-time injected public env vars.
        allowRaw,
        // Public links currently disclose the token-derived DEK wrapping secret to the relay.
        // Only a trusted client build may opt in; server/account settings cannot lift this deny.
        denyRaw: publicSharingEnabled ? denyRaw : [denyRaw, 'sharing.public'].filter(Boolean).join(','),
    });
    cachedBuildPolicy = next;
    cachedBuildPolicyKey = key;
    return next;
}

export function getFeatureBuildPolicyDecision(featureId: FeatureId): FeatureBuildPolicyEvaluation {
    const buildPolicy = resolveBuildPolicyFromEnv();
    return evaluateFeatureBuildPolicy(buildPolicy, featureId);
}
