const ErrorResponse = require('../utils/errorResponse');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const { isFeatureEnabled, getSubscriptionSummary, normalizePlanName } = require('../utils/subscriptionFeatureUtils');
const { PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE } = require('./subscriptionLimits');

const getOrganizationId = (req) => {
    const org = req.user && req.user.organization;
    if (!org) return null;
    if (typeof org === 'object' && org._id) return org._id;
    return org;
};

const getOrganizationForFeatureCheck = async (req) => {
    const org = req.user && req.user.organization;
    if (!org) return null;

    const organizationId = getOrganizationId(req);
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

exports.checkSubscriptionFeature = (featureKey) => {
    return async (req, res, next) => {
        try {
            if (!req.user || !req.user.organization) {
                return next(new ErrorResponse('User subscription data is unavailable', 403));
            }

            const organization = await getOrganizationForFeatureCheck(req);
            if (!organization) {
                return next(new ErrorResponse('Organization not found for this user', 400));
            }

            const subscriptionSummary = getSubscriptionSummary(organization);

            if (!subscriptionSummary.isSubscriptionActive) {
                return next(new ErrorResponse('Your organization subscription is not active. Please renew or reactivate your plan.', 403));
            }

            if (!isFeatureEnabled(organization, featureKey)) {
                if (subscriptionSummary.subscriptionPlan === 'free') {
                    return next(new ErrorResponse(
                        `This feature is not available on the Free plan. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`,
                        403
                    ));
                }

                return next(new ErrorResponse(
                    `This feature is not available on your current plan (${subscriptionSummary.subscriptionLabel}). Please upgrade to access ${featureKey.replace(/_/g, ' ')}.`,
                    403
                ));
            }

            next();
        } catch (error) {
            console.error('❌ Error checking subscription feature:', error.message);
            return next(new ErrorResponse('Error checking subscription feature access', 500));
        }
    };
};
