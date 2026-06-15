const Role = require('../models/Role');
const User = require('../models/User');
const Client = require('../models/Client');
const Case = require('../models/Case');
const ErrorResponse = require('../utils/errorResponse');
const { getSubscriptionSummary } = require('../utils/subscriptionFeatureUtils');

const PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE = 'Please upgrade to Professional Monthly plan to continue.';

const getOrganizationId = (req) => {
    const org = req.user && req.user.organization;
    if (!org) return null;
    if (typeof org === 'object' && org._id) return org._id;
    return org;
};

const limitExceededMessage = (summary, label, limit) => {
    const planLabel = summary.subscriptionLabel || 'Current';
    const upgradeMessage = summary.subscriptionPlan === 'free'
        ? PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE
        : 'Please upgrade your plan to continue.';
    return `${planLabel} plan allows only ${limit} ${label}. ${upgradeMessage}`;
};

const checkLimit = ({ limitKey, label, countDocuments }) => async (req, res, next) => {
    try {
        if (!req.user || !req.user.organization) {
            return next(new ErrorResponse('User subscription data is unavailable', 403));
        }

        const summary = getSubscriptionSummary(req.user.organization);
        const limit = summary.subscriptionLimits ? summary.subscriptionLimits[limitKey] : null;
        if (limit === null || limit === undefined) return next();

        const organizationId = getOrganizationId(req);
        if (!organizationId) {
            return next(new ErrorResponse('Organization not found for this user', 400));
        }

        const current = await countDocuments(organizationId);
        if (current >= limit) {
            return next(new ErrorResponse(limitExceededMessage(summary, label, limit), 403));
        }

        return next();
    } catch (error) {
        console.error('Error checking subscription limit:', error.message);
        return next(new ErrorResponse('Error checking subscription limits', 500));
    }
};

exports.PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE = PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE;

exports.checkRoleLimit = checkLimit({
    limitKey: 'maxRoles',
    label: 'roles',
    countDocuments: (organizationId) => Role.countDocuments({
        organization: organizationId,
        isSystemRole: false
    })
});

exports.checkUserLimit = checkLimit({
    limitKey: 'maxUsers',
    label: 'users',
    countDocuments: (organizationId) => User.countDocuments({
        organization: organizationId,
        status: { $nin: ['terminated'] }
    })
});

exports.checkClientLimit = checkLimit({
    limitKey: 'maxClients',
    label: 'clients',
    countDocuments: (organizationId) => Client.countDocuments({
        organization: organizationId,
        deletedAt: null
    })
});

exports.checkCaseLimit = checkLimit({
    limitKey: 'maxCases',
    label: 'cases',
    countDocuments: (organizationId) => Case.countDocuments({
        organization: organizationId,
        deletedAt: null
    })
});
