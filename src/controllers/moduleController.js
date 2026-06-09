// controllers/moduleController.js
// Module management controller

const Module = require('../models/Module');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const { getActionsForModule } = require('../utils/roleUtils');
const { validateOrganizationSubscription } = require('../utils/subscriptionUtils');

/**
 * @desc    Get all active modules (with allowed actions). Includes `assignee` on client/cases when
 *          the current user’s role has assignee on that module (or SUPER_ADMIN). Unauthenticated: no assignee.
 * @route   GET /api/modules
 * @access  Public; optional Bearer token refines actions for the signed-in user
 */
exports.getModules = asyncHandler(async (req, res, next) => {
    let includeAssignee = false;
    let onlySubscriptionModule = false;

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
    }

    const query = { isActive: true };
    if (onlySubscriptionModule) {
        query.name = 'subscription';
    }

    const modules = await Module.find(query)
        .select('_id name displayName description')
        .sort({ name: 1 })
        .lean();

    const data = modules.map((m) => ({
        _id: m._id,
        name: m.name,
        displayName: m.displayName,
        description: m.description,
        actions: getActionsForModule(m.name, actionOpts)
    }));

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
