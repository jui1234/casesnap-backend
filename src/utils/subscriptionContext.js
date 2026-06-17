const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const { getSubscriptionSummary, normalizePlanName } = require('./subscriptionFeatureUtils');

const getOrganizationIdFromUser = (user) => {
    const org = user && user.organization;
    if (!org) return null;
    if (typeof org === 'object' && org._id) return org._id;
    return org;
};

const getEffectiveSubscriptionOrganization = async (user) => {
    const org = user && user.organization;
    if (!org) return null;

    const organizationId = getOrganizationIdFromUser(user);
    if (!organizationId) return null;

    const organization = typeof org === 'object' && org.subscriptionPlan
        ? org
        : await Organization.findById(organizationId)
            .select('subscriptionPlan subscriptionStatus subscriptionExpiresAt')
            .lean();

    const activeSubscription = await Subscription.findOne({
        organization: organizationId,
        status: 'active'
    })
        .sort({ createdAt: -1 })
        .select('planName status expiresAt')
        .lean();

    if (
        activeSubscription &&
        normalizePlanName(activeSubscription.planName) !== 'free' &&
        normalizePlanName(organization?.subscriptionPlan) === 'free'
    ) {
        return {
            ...(organization || {}),
            subscriptionPlan: activeSubscription.planName,
            subscriptionStatus: activeSubscription.status,
            subscriptionExpiresAt: activeSubscription.expiresAt
        };
    }

    return organization;
};

const getEffectiveSubscriptionSummaryForUser = async (user) => {
    const organization = await getEffectiveSubscriptionOrganization(user);
    return organization ? getSubscriptionSummary(organization) : null;
};

module.exports = {
    getOrganizationIdFromUser,
    getEffectiveSubscriptionOrganization,
    getEffectiveSubscriptionSummaryForUser
};
