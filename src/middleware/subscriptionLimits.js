const Role = require('../models/Role');
const User = require('../models/User');
const Client = require('../models/Client');
const Case = require('../models/Case');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const ErrorResponse = require('../utils/errorResponse');
const { getSubscriptionSummary, normalizePlanName } = require('../utils/subscriptionFeatureUtils');

const PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE = 'Please upgrade to Professional Monthly plan to continue.';
const FREE_PLAN_ROLE_LIMIT_MESSAGE = 'Free plan allows only 2 roles. Please upgrade to Professional Monthly plan to continue.';
const FREE_PLAN_ASSIGNEE_LIMIT_MESSAGE = 'Assignee limit reached. Your current plan allows a maximum of 2 assignee roles. Upgrade to the Professional Monthly Plan to add more team members.';

const getOrganizationId = (req) => {
    const org = req.user && req.user.organization;
    if (!org) return null;
    if (typeof org === 'object' && org._id) return org._id;
    return org;
};

const limitExceededMessage = (summary, label, limit) => {
    if (summary.subscriptionPlan === 'free' && label === 'roles' && limit === 2) {
        return FREE_PLAN_ROLE_LIMIT_MESSAGE;
    }

    const planLabel = summary.subscriptionLabel || 'Current';
    const upgradeMessage = summary.subscriptionPlan === 'free'
        ? PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE
        : 'Please upgrade your plan to continue.';
    return `${planLabel} plan allows only ${limit} ${label}. ${upgradeMessage}`;
};

const assigneeLimitExceededMessage = ({ planName, limit, current, label = 'assignee(s)' }) => {
    if (normalizePlanName(planName) === 'free') {
        return FREE_PLAN_ASSIGNEE_LIMIT_MESSAGE;
    }

    return `Assignee limit reached for your plan (${limit} ${label}, including SUPER_ADMIN). Current assignees: ${current}. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`;
};

const getOrganizationForLimitCheck = async (req) => {
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

const checkLimit = ({ limitKey, label, countDocuments }) => async (req, res, next) => {
    try {
        if (!req.user || !req.user.organization) {
            return next(new ErrorResponse('User subscription data is unavailable', 403));
        }

        const organization = await getOrganizationForLimitCheck(req);
        if (!organization) {
            return next(new ErrorResponse('Organization not found for this user', 400));
        }

        const summary = getSubscriptionSummary(organization);
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
exports.FREE_PLAN_ROLE_LIMIT_MESSAGE = FREE_PLAN_ROLE_LIMIT_MESSAGE;
exports.FREE_PLAN_ASSIGNEE_LIMIT_MESSAGE = FREE_PLAN_ASSIGNEE_LIMIT_MESSAGE;
exports.assigneeLimitExceededMessage = assigneeLimitExceededMessage;

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
