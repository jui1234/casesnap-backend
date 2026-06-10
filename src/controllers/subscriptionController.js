// controllers/subscriptionController.js

const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const Organization = require('../models/Organization');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const { getSubscriptionSummary, normalizePlanName } = require('../utils/subscriptionFeatureUtils');

// @desc      Get all subscriptions (super admin only)
// @route     GET /api/subscriptions
// @access    Private (Super Admin)
exports.getSubscriptions = asyncHandler(async (req, res, next) => {
    const { page = 1, limit = 10, status, organizationId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};

    if (status) {
        query.status = status;
    }

    if (organizationId) {
        query.organization = organizationId;
    }

    const subscriptions = await Subscription.find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('organization', 'companyName')
        .populate('createdBy', 'email firstName lastName')
        .populate('updatedBy', 'email firstName lastName')
        .sort({ createdAt: -1 });

    const total = await Subscription.countDocuments(query);

    res.status(200).json({
        success: true,
        data: subscriptions,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
        }
    });
});

// @desc      Get subscription by ID (super admin only)
// @route     GET /api/subscriptions/:id
// @access    Private (Super Admin)
exports.getSubscription = asyncHandler(async (req, res, next) => {
    const subscription = await Subscription.findById(req.params.id)
        .populate('organization', 'companyName companyEmail subscriptionPlan subscriptionStatus')
        .populate('createdBy', 'email firstName lastName')
        .populate('updatedBy', 'email firstName lastName');

    if (!subscription) {
        return next(new ErrorResponse('Subscription not found', 404));
    }

    res.status(200).json({
        success: true,
        data: subscription
    });
});

// @desc      Get subscription for organization (super admin only)
// @route     GET /api/subscriptions/org/:organizationId
// @access    Private (Super Admin)
exports.getOrganizationSubscription = asyncHandler(async (req, res, next) => {
    const subscription = await Subscription.findOne({ organization: req.params.organizationId })
        .sort({ createdAt: -1 })
        .populate('organization', 'companyName companyEmail subscriptionPlan subscriptionStatus')
        .populate('createdBy', 'email firstName lastName')
        .populate('updatedBy', 'email firstName lastName');

    if (!subscription) {
        return next(new ErrorResponse('No subscription found for this organization', 404));
    }

    res.status(200).json({
        success: true,
        data: subscription
    });
});

// @desc      List available subscription plans
// @route     GET /api/subscriptions/plans
// @access    Private (Authenticated users)
exports.getSubscriptionPlans = asyncHandler(async (req, res, next) => {
    const plans = await SubscriptionPlan.find({ isActive: true })
        .select('-__v')
        .sort({ price: 1 })
        .lean();

    res.status(200).json({
        success: true,
        count: plans.length,
        data: plans
    });
});

// @desc      Assign a plan to an organization
// @route     PUT /api/subscriptions/organizations/:organizationId/assign
// @access    Private (Super Admin)
exports.assignSubscriptionPlanToOrganization = asyncHandler(async (req, res, next) => {
    const { organizationId } = req.params;
    const { planName, planId, expiresAt, status, price, currency, billingCycle, autoRenew, notes } = req.body;

    if (!planName && !planId) {
        return next(new ErrorResponse('Plan name or plan ID is required', 400));
    }

    let plan;
    if (planId) {
        plan = await SubscriptionPlan.findById(planId);
    }
    if (!plan && planName) {
        const normalizedPlanName = normalizePlanName(planName);
        plan = await SubscriptionPlan.findOne({ planName: normalizedPlanName, isActive: true });
    }

    if (!plan) {
        return next(new ErrorResponse('Subscription plan not found', 404));
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    organization.subscriptionPlan = plan.planName;
    organization.subscriptionStatus = status || 'active';

    if (expiresAt) {
        const parsedDate = new Date(expiresAt);
        if (Number.isNaN(parsedDate.getTime())) {
            return next(new ErrorResponse('Invalid expiresAt date format', 400));
        }
        organization.subscriptionExpiresAt = parsedDate;
    } else if (plan.planName === 'free') {
        const trialExpiresAt = new Date();
        trialExpiresAt.setDate(trialExpiresAt.getDate() + 14);
        organization.subscriptionExpiresAt = trialExpiresAt;
    }

    await organization.save();

    res.status(200).json({
        success: true,
        message: 'Subscription plan assigned successfully',
        data: {
            organizationId: organization._id,
            subscriptionPlan: organization.subscriptionPlan,
            subscriptionStatus: organization.subscriptionStatus,
            subscriptionExpiresAt: organization.subscriptionExpiresAt,
            plan
        }
    });
});

// @desc      Get current user's organization subscription details
// @route     GET /api/subscriptions/current
// @access    Private (Authenticated users)
exports.getCurrentSubscription = asyncHandler(async (req, res, next) => {
    if (!req.user || !req.user.organization) {
        return next(new ErrorResponse('Organization subscription information is unavailable', 404));
    }

    const summary = getSubscriptionSummary(req.user.organization);

    res.status(200).json({
        success: true,
        data: {
            subscriptionPlan: summary.subscriptionPlan,
            subscriptionLabel: summary.subscriptionLabel,
            subscriptionStatus: summary.subscriptionStatus,
            subscriptionExpiresAt: summary.subscriptionExpiresAt,
            subscriptionFeatures: summary.subscriptionFeatures,
            subscriptionFeatureFlags: summary.subscriptionFeatureFlags,
            subscriptionLimits: summary.subscriptionLimits,
            isSubscriptionActive: summary.isSubscriptionActive,
            isSubscriptionExpired: summary.isSubscriptionExpired
        }
    });
});

// @desc      Create a new subscription (super admin only)
// @route     POST /api/subscriptions
// @access    Private (Super Admin)
exports.createSubscription = asyncHandler(async (req, res, next) => {
    const {
        organization,
        planName,
        status,
        startDate,
        expiresAt,
        price,
        currency,
        maxUsers,
        maxClients,
        maxCases,
        features,
        billingCycle,
        autoRenew,
        notes
    } = req.body;

    // Validate required fields
    if (!organization) {
        return next(new ErrorResponse('Organization is required', 400));
    }

    if (!planName) {
        return next(new ErrorResponse('Plan name is required', 400));
    }

    if (!expiresAt) {
        return next(new ErrorResponse('Expiration date is required', 400));
    }

    if (price === undefined || price === null) {
        return next(new ErrorResponse('Price is required', 400));
    }

    // Check if organization exists
    const org = await Organization.findById(organization);
    if (!org) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    // Check if organization already has an active/inactive subscription
    const existingSubscription = await Subscription.findOne({
        organization,
        status: { $in: ['active', 'inactive'] }
    });

    if (existingSubscription) {
        return next(new ErrorResponse('Organization already has an active or inactive subscription', 400));
    }

    const subscription = await Subscription.create({
        organization,
        planName,
        status: status || 'active',
        startDate: startDate || new Date(),
        expiresAt,
        price,
        currency: currency || 'INR',
        maxUsers,
        maxClients,
        maxCases,
        features: features || [],
        billingCycle: billingCycle || 'annual',
        autoRenew: autoRenew !== undefined ? autoRenew : true,
        notes,
        createdBy: req.user._id
    });

    // Update organization's subscription fields
    await Organization.findByIdAndUpdate(
        organization,
        {
            subscriptionPlan: planName,
            subscriptionStatus: status || 'active',
            subscriptionExpiresAt: expiresAt
        },
        { new: true }
    );

    const populatedSubscription = await Subscription.findById(subscription._id)
        .populate('organization', 'companyName')
        .populate('createdBy', 'email firstName lastName');

    res.status(201).json({
        success: true,
        message: 'Subscription created successfully',
        data: populatedSubscription
    });
});

// @desc      Update a subscription (super admin only)
// @route     PUT /api/subscriptions/:id
// @access    Private (Super Admin)
exports.updateSubscription = asyncHandler(async (req, res, next) => {
    const { id } = req.params;

    let subscription = await Subscription.findById(id);

    if (!subscription) {
        return next(new ErrorResponse('Subscription not found', 404));
    }

    // Update allowed fields
    const {
        planName,
        status,
        expiresAt,
        price,
        currency,
        maxUsers,
        maxClients,
        maxCases,
        features,
        billingCycle,
        autoRenew,
        notes
    } = req.body;

    if (planName !== undefined) subscription.planName = planName;
    if (status !== undefined) subscription.status = status;
    if (expiresAt !== undefined) subscription.expiresAt = expiresAt;
    if (price !== undefined) subscription.price = price;
    if (currency !== undefined) subscription.currency = currency;
    if (maxUsers !== undefined) subscription.maxUsers = maxUsers;
    if (maxClients !== undefined) subscription.maxClients = maxClients;
    if (maxCases !== undefined) subscription.maxCases = maxCases;
    if (features !== undefined) subscription.features = features;
    if (billingCycle !== undefined) subscription.billingCycle = billingCycle;
    if (autoRenew !== undefined) subscription.autoRenew = autoRenew;
    if (notes !== undefined) subscription.notes = notes;

    subscription.updatedBy = req.user._id;

    subscription = await subscription.save();

    // Update organization's subscription fields if plan or status changed
    if (planName || status || expiresAt) {
        await Organization.findByIdAndUpdate(
            subscription.organization,
            {
                ...(planName && { subscriptionPlan: planName }),
                ...(status && { subscriptionStatus: status }),
                ...(expiresAt && { subscriptionExpiresAt: expiresAt })
            },
            { new: true }
        );
    }

    const updatedSubscription = await Subscription.findById(id)
        .populate('organization', 'companyName')
        .populate('createdBy', 'email firstName lastName')
        .populate('updatedBy', 'email firstName lastName');

    res.status(200).json({
        success: true,
        message: 'Subscription updated successfully',
        data: updatedSubscription
    });
});

// @desc      Delete a subscription (super admin only)
// @route     DELETE /api/subscriptions/:id
// @access    Private (Super Admin)
exports.deleteSubscription = asyncHandler(async (req, res, next) => {
    const { id } = req.params;

    const subscription = await Subscription.findById(id);

    if (!subscription) {
        return next(new ErrorResponse('Subscription not found', 404));
    }

    await Subscription.findByIdAndDelete(id);

    // Update organization's subscription to inactive
    await Organization.findByIdAndUpdate(
        subscription.organization,
        {
            subscriptionStatus: 'cancelled',
            subscriptionExpiresAt: new Date()
        },
        { new: true }
    );

    res.status(200).json({
        success: true,
        message: 'Subscription deleted successfully',
        data: {}
    });
});

// @desc      Renew a subscription (super admin only)
// @route     POST /api/subscriptions/:id/renew
// @access    Private (Super Admin)
exports.renewSubscription = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { expiresAt, autoRenew } = req.body;

    if (!expiresAt) {
        return next(new ErrorResponse('New expiration date is required', 400));
    }

    let subscription = await Subscription.findById(id);

    if (!subscription) {
        return next(new ErrorResponse('Subscription not found', 404));
    }

    subscription.expiresAt = new Date(expiresAt);
    subscription.status = 'active';
    if (autoRenew !== undefined) subscription.autoRenew = autoRenew;
    subscription.updatedBy = req.user._id;

    subscription = await subscription.save();

    // Update organization's subscription fields
    await Organization.findByIdAndUpdate(
        subscription.organization,
        {
            subscriptionStatus: 'active',
            subscriptionExpiresAt: expiresAt
        },
        { new: true }
    );

    const renewedSubscription = await Subscription.findById(id)
        .populate('organization', 'companyName')
        .populate('createdBy', 'email firstName lastName')
        .populate('updatedBy', 'email firstName lastName');

    res.status(200).json({
        success: true,
        message: 'Subscription renewed successfully',
        data: renewedSubscription
    });
});

// @desc      Get subscription statistics (super admin only)
// @route     GET /api/subscriptions/stats/overview
// @access    Private (Super Admin)
exports.getSubscriptionStats = asyncHandler(async (req, res, next) => {
    const stats = await Subscription.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                totalPrice: { $sum: '$price' }
            }
        }
    ]);

    const planStats = await Subscription.aggregate([
        {
            $group: {
                _id: '$planName',
                count: { $sum: 1 },
                totalPrice: { $sum: '$price' }
            }
        }
    ]);

    res.status(200).json({
        success: true,
        data: {
            byStatus: stats,
            byPlan: planStats
        }
    });
});
