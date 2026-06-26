// controllers/moduleController.js
// Module management controller

const Module = require('../models/Module');
const Role = require('../models/Role');
const User = require('../models/User');
const Client = require('../models/Client');
const Case = require('../models/Case');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const { getActionsForModule } = require('../utils/roleUtils');
const { validateOrganizationSubscription } = require('../utils/subscriptionUtils');
const { getSubscriptionSummary, isFeatureEnabled } = require('../utils/subscriptionFeatureUtils');

const PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE = 'Please upgrade to Professional Monthly plan to continue.';
const FREE_PLAN_ROLE_LIMIT_MESSAGE = 'Free plan allows only 2 roles. Please upgrade to Professional Monthly plan to continue.';

const getOrganizationId = (user) => {
    const org = user && user.organization;
    if (!org) return null;
    if (typeof org === 'object' && org._id) return org._id;
    return org;
};

const LIMIT_CONFIG = {
    role: {
        limitKey: 'maxRoles',
        label: 'roles',
        count: (organizationId) => Role.countDocuments({
            organization: organizationId,
            isSystemRole: false
        })
    },
    user: {
        limitKey: 'maxUsers',
        label: 'users',
        count: (organizationId) => User.countDocuments({
            organization: organizationId,
            status: { $nin: ['terminated'] }
        })
    },
    client: {
        limitKey: 'maxClients',
        label: 'clients',
        count: (organizationId) => Client.countDocuments({
            organization: organizationId,
            deletedAt: null
        })
    },
    cases: {
        limitKey: 'maxCases',
        label: 'cases',
        count: (organizationId) => Case.countDocuments({
            organization: organizationId,
            deletedAt: null
        })
    }
};

const buildLimitMessage = (summary, label, max) => {
    if (summary.subscriptionPlan === 'free' && label === 'roles' && max === 2) {
        return FREE_PLAN_ROLE_LIMIT_MESSAGE;
    }

    const planLabel = summary.subscriptionLabel || 'Current';
    const upgradeMessage = summary.subscriptionPlan === 'free'
        ? PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE
        : 'Please upgrade your plan to continue.';
    return `${planLabel} plan allows only ${max} ${label}. ${upgradeMessage}`;
};

async function getModuleLimitInfo(user) {
    const organizationId = getOrganizationId(user);
    if (!user || !user.organization || !organizationId) return {};

    const summary = getSubscriptionSummary(user.organization);
    const limits = summary.subscriptionLimits || {};
    const entries = Object.entries(LIMIT_CONFIG);

    const counts = await Promise.all(entries.map(async ([moduleName, config]) => {
        const max = limits[config.limitKey];
        if (max === null || max === undefined) return [moduleName, null];

        const used = await config.count(organizationId);
        const remaining = Math.max(max - used, 0);
        const canCreate = remaining > 0;

        return [moduleName, {
            limitKey: config.limitKey,
            max,
            used,
            remaining,
            canCreate,
            message: canCreate ? null : buildLimitMessage(summary, config.label, max)
        }];
    }));

    return counts.reduce((acc, [moduleName, info]) => {
        if (info) acc[moduleName] = info;
        return acc;
    }, {});
}

function getModuleFeatureInfo(user, moduleName) {
    if (!user || !user.organization) return null;

    const name = String(moduleName || '').toLowerCase().trim();
    if (name !== 'cases' && name !== 'client') return null;

    const summary = getSubscriptionSummary(user.organization);
    const subscriptionActive = summary.isSubscriptionActive;
    const excelImportExportEnabled = subscriptionActive && isFeatureEnabled(user.organization, 'excel_import_export');
    const caseAssignmentEnabled = subscriptionActive && isFeatureEnabled(user.organization, 'case_assignment');

    return {
        canTemplate: excelImportExportEnabled,
        canImport: excelImportExportEnabled,
        canExport: excelImportExportEnabled,
        canBulkAssign: caseAssignmentEnabled
    };
}

/**
 * @desc    Get all active modules (with allowed actions). Includes `assignee` on client/cases when
 *          the current user’s role has assignee on that module (or SUPER_ADMIN). Unauthenticated: no assignee.
 * @route   GET /api/modules
 * @access  Public; optional Bearer token refines actions for the signed-in user
 */
exports.getModules = asyncHandler(async (req, res, next) => {
    let includeAssignee = false;
    let onlySubscriptionModule = false;
    let moduleLimitInfo = {};

    if (req.user) {
        await req.user.populate({
            path: 'role',
            select: 'name priority isSystemRole permissions'
        });
        const role = req.user.role;
        const isSuperAdmin = role && role.priority === 1 && role.isSystemRole === true;

        if (isSuperAdmin) {
            includeAssignee = true;
            const subscriptionCheck = validateOrganizationSubscription(req.user.organization);
            const expiredMessage = 'Your subscription plan has expired. Please renew your plan to continue.';
            if (!subscriptionCheck.valid && subscriptionCheck.reason === expiredMessage) {
                onlySubscriptionModule = true;
            }
        }

        if (!onlySubscriptionModule) {
            moduleLimitInfo = await getModuleLimitInfo(req.user);
        }
    }

    const query = { isActive: true };
    if (onlySubscriptionModule) {
        query.name = 'subscription';
    }

    const modules = await Module.find(query)
        .select('_id name displayName description')
        .sort({ name: 1 })
        .lean();

    const actionOpts = { includeAssignee };

    const data = modules.map((m) => {
        const actions = getActionsForModule(m.name, actionOpts);
        const featureInfo = getModuleFeatureInfo(req.user, m.name);

        return {
            _id: m._id,
            name: m.name,
            displayName: m.displayName,
            description: m.description,
            actions,
            ...(moduleLimitInfo[m.name] ? { subscriptionLimit: moduleLimitInfo[m.name] } : {}),
            ...(featureInfo ? { subscriptionFeatures: featureInfo } : {})
        };
    });

    res.status(200).json({
        success: true,
        count: data.length,
        data
    });
});

/**
 * @desc    Create a new module
 * @route   POST /api/modules
 * @access  Private (Admin only - for adding new collections)
 */
exports.createModule = asyncHandler(async (req, res, next) => {
    const { name, displayName, description } = req.body;

    // Validate required fields
    if (!name || !displayName) {
        return next(new ErrorResponse('Module name and display name are required', 400));
    }

    // Normalize name to lowercase
    const normalizedName = name.toLowerCase().trim();

    // Check if module already exists
    const existingModule = await Module.findOne({ name: normalizedName });
    if (existingModule) {
        return next(new ErrorResponse(`Module with name "${name}" already exists`, 400));
    }

    // Create module
    const module = await Module.create({
        name: normalizedName,
        displayName,
        description: description || ''
    });

    console.log('✅ Module created:', {
        id: module._id,
        name: module.name,
        displayName: module.displayName
    });

    res.status(201).json({
        success: true,
        message: 'Module created successfully',
        data: {
            id: module._id,
            name: module.name,
            displayName: module.displayName,
            description: module.description,
            isActive: module.isActive,
            createdAt: module.createdAt
        }
    });
});

/**
 * @desc    Update module
 * @route   PUT /api/modules/:moduleId
 * @access  Private (Admin only)
 */
exports.updateModule = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;
    const { displayName, description, isActive } = req.body;

    const module = await Module.findById(moduleId);

    if (!module) {
        return next(new ErrorResponse('Module not found', 404));
    }

    // Update fields
    if (displayName !== undefined) module.displayName = displayName;
    if (description !== undefined) module.description = description;
    if (isActive !== undefined) module.isActive = isActive;

    await module.save();

    res.status(200).json({
        success: true,
        message: 'Module updated successfully',
        data: module
    });
});

/**
 * @desc    Delete module (soft delete by setting isActive to false)
 * @route   DELETE /api/modules/:moduleId
 * @access  Private (Admin only)
 */
exports.deleteModule = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    const module = await Module.findById(moduleId);

    if (!module) {
        return next(new ErrorResponse('Module not found', 404));
    }

    // Soft delete by setting isActive to false
    module.isActive = false;
    await module.save();

    res.status(200).json({
        success: true,
        message: 'Module deactivated successfully'
    });
});
