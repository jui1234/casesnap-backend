// utils/subscriptionFeatureUtils.js
// Subscription plan feature mapping and feature gating helpers

const { isSubscriptionExpired } = require('./subscriptionUtils');

const LEGACY_PLAN_ALIASES = {
    free: 'free',
    trial: 'free',
    base: 'basic_monthly',
    basic: 'basic_monthly',
    basic_plan: 'basic_monthly',
    basicmonthly: 'basic_monthly',
    basic_monthly_plan: 'basic_monthly',
    basic_montly: 'basic_monthly',
    basic_montlhy: 'basic_monthly',
    popular: 'professional_monthly'
};

const PLAN_CONFIG = {
    free: {
        label: 'Free',
        features: [],
        limits: {
            maxRoles: 2,
            maxUsers: 2,
            maxClients: 2,
            maxCases: 2,
            maxAssignees: 2
        }
    },
    basic_monthly: {
        label: 'Basic Monthly',
        features: ['case_assignment', 'excel_import_export'],
        limits: {
            maxRoles: 5,
            maxUsers: 150,
            maxClients: 150,
            maxCases: 150,
            maxAssignees: 3,
            maxExcelImportRows: 50
        }
    },
    basic_yearly: {
        label: 'Basic Yearly',
        features: ['case_assignment', 'excel_import_export'],
        limits: {
            maxRoles: 15,
            maxUsers: 15,
            maxClients: 250,
            maxCases: 500,
            maxAssignees: 4
        }
    },
    professional_monthly: {
        label: 'Professional Monthly',
        features: ['case_assignment', 'excel_import_export', 'case_approval', 'audit_logs', 'analytics'],
        limits: {
            maxRoles: null,
            maxUsers: null,
            maxClients: null,
            maxCases: null,
            maxAssignees: null,
            maxExcelImportRows: 100
        }
    },
    professional_yearly: {
        label: 'Professional Yearly',
        features: ['case_assignment', 'excel_import_export', 'case_approval', 'audit_logs', 'analytics'],
        limits: {
            maxRoles: 50,
            maxUsers: 50,
            maxClients: 2000,
            maxCases: 4000,
            maxAssignees: 10
        }
    }
};

const normalizePlanName = (planName) => {
    if (!planName) return 'free';
    const normalized = String(planName)
        .toLowerCase()
        .trim()
        .replace(/[-\s]+/g, '_');
    return LEGACY_PLAN_ALIASES[normalized] || normalized;
};

const getPlanConfig = (planName) => {
    const normalized = normalizePlanName(planName);
    return PLAN_CONFIG[normalized] || PLAN_CONFIG.free;
};

const getSubscriptionFeatures = (planName) => {
    return getPlanConfig(planName).features || [];
};

const getSubscriptionFeatureFlags = (planName) => {
    const features = getSubscriptionFeatures(planName);
    return features.reduce((flags, feature) => {
        flags[feature] = true;
        return flags;
    }, {});
};

const getPlanLimits = (planName) => {
    return getPlanConfig(planName).limits || {};
};

const getExcelImportRowLimit = (organizationOrPlan, fallback = 5000) => {
    const planName = typeof organizationOrPlan === 'object'
        ? organizationOrPlan?.subscriptionPlan
        : organizationOrPlan;
    const limit = getPlanLimits(planName).maxExcelImportRows;
    return limit || fallback;
};

const getSubscriptionSummary = (organization = {}) => {
    const planName = normalizePlanName(organization.subscriptionPlan);
    const config = getPlanConfig(planName);
    const status = String(organization.subscriptionStatus || 'active').toLowerCase().trim();
    const expiresAt = organization.subscriptionExpiresAt || null;
    const expired = isSubscriptionExpired(expiresAt);

    return {
        subscriptionPlan: planName,
        subscriptionLabel: config.label,
        subscriptionStatus: status,
        subscriptionExpiresAt: expiresAt,
        subscriptionFeatures: config.features,
        subscriptionFeatureFlags: getSubscriptionFeatureFlags(planName),
        subscriptionLimits: config.limits,
        isSubscriptionActive: status === 'active' && !expired,
        isSubscriptionExpired: expired
    };
};

const isFeatureEnabled = (organization = {}, featureKey) => {
    if (!featureKey) return false;
    const planName = normalizePlanName(organization.subscriptionPlan);
    const flags = getSubscriptionFeatureFlags(planName);
    return Boolean(flags[featureKey]);
};

module.exports = {
    normalizePlanName,
    getPlanConfig,
    getSubscriptionFeatures,
    getSubscriptionFeatureFlags,
    getPlanLimits,
    getExcelImportRowLimit,
    getSubscriptionSummary,
    isFeatureEnabled
};
