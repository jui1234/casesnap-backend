const ErrorResponse = require('../utils/errorResponse');
const { isFeatureEnabled, getSubscriptionSummary } = require('../utils/subscriptionFeatureUtils');
const { PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE } = require('./subscriptionLimits');

exports.checkSubscriptionFeature = (featureKey) => {
    return async (req, res, next) => {
        try {
            if (!req.user || !req.user.organization) {
                return next(new ErrorResponse('User subscription data is unavailable', 403));
            }

            const subscriptionSummary = getSubscriptionSummary(req.user.organization);

            if (!subscriptionSummary.isSubscriptionActive) {
                return next(new ErrorResponse('Your organization subscription is not active. Please renew or reactivate your plan.', 403));
            }

            if (!isFeatureEnabled(req.user.organization, featureKey)) {
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
