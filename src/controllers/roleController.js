// controllers/roleController.js
// Role management controller with priority-based RBAC

const Role = require('../models/Role');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Module = require('../models/Module');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const { getSuggestedPriority, validateRoleCreation, validatePermissions, getActionsForModule } = require('../utils/roleUtils');
const { getAssigneeLimit, getCurrentAssigneeCount, getAssigneeRoleCount, roleHasAssigneePermission, checkAssigneeLimit } = require('../utils/assigneeUtils');
const { PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE } = require('../middleware/subscriptionLimits');

/**
 * @desc    Get suggested priority for new role
 * @route   GET /api/roles/suggest-priority
 * @access  Private (Admin with role)
 */
exports.getSuggestedPriority = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;

    const suggestedPriority = await getSuggestedPriority(organizationId);

    res.status(200).json({
        success: true,
        data: {
            suggestedPriority
        }
    });
});

/**
 * @desc    Create a new role
 * @route   POST /api/roles
 * @access  Private (Admin with role)
 */
exports.createRole = asyncHandler(async (req, res, next) => {
    const { name, description, priority, permissions } = req.body;
    const organizationId = req.user.organization;
    const creatorRole = req.userRole;

    console.log('📝 Creating role:', {
        name,
        priority,
        organizationId,
        creatorRolePriority: creatorRole?.priority,
        creatorRoleIsSystemRole: creatorRole?.isSystemRole,
        permissionsCount: permissions?.length
    });

    // Validate required fields
    if (!name) {
        return next(new ErrorResponse('Role name is required', 400));
    }

    if (!priority || priority < 1) {
        return next(new ErrorResponse('Priority must be a positive number', 400));
    }

    // Validate permissions structure (async)
    const permissionValidation = await validatePermissions(permissions || []);
    if (!permissionValidation.valid) {
        console.log('❌ Permission validation failed:', permissionValidation.error);
        return next(new ErrorResponse(permissionValidation.error, 400));
    }

    // Only SUPER_ADMIN can grant assignee permission (client/cases)
    const isSuperAdminForAssignee = creatorRole.priority === 1 && creatorRole.isSystemRole === true;
    const permissionsWithAssignee = (permissions || []).filter(
        (p) => (p.module === 'client' || p.module === 'cases') && (p.actions || []).includes('assignee')
    );
    if (permissionsWithAssignee.length > 0 && !isSuperAdminForAssignee) {
        return next(new ErrorResponse('Only SUPER_ADMIN can grant assignee permission for client/cases', 403));
    }

    // Enforce assignee limit when creating role with assignee permission (applies to SUPER_ADMIN too)
    if (permissionsWithAssignee.length > 0) {
        const org = await Organization.findById(organizationId).select('subscriptionPlan').lean();
        const limit = getAssigneeLimit(org?.subscriptionPlan || 'free');
        const currentAssigneeRoleCount = await getAssigneeRoleCount(organizationId);
        if (currentAssigneeRoleCount >= limit) {
            return next(new ErrorResponse(
                `Assignee limit reached for your plan (${limit} assignee role(s), including SUPER_ADMIN). Current: ${currentAssigneeRoleCount}. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`,
                400
            ));
        }
    }

    // Check if user can create this role
    const creationValidation = validateRoleCreation(creatorRole, priority);
    if (!creationValidation.valid) {
        console.log('❌ Role creation validation failed:', creationValidation.error);
        return next(new ErrorResponse(creationValidation.error, 403));
    }

    // Check if priority already exists in organization
    const existingRole = await Role.findOne({
        organization: organizationId,
        priority: priority
    });

    if (existingRole) {
        return next(new ErrorResponse(
            `Priority ${priority} already exists in this organization`,
            400
        ));
    }

    // Prevent creating role with priority 1 (reserved for SUPER_ADMIN)
    // Check if creator is SUPER_ADMIN (priority 1 and isSystemRole true)
    const isSuperAdmin = creatorRole.priority === 1 && creatorRole.isSystemRole === true;
    if (priority === 1 && !isSuperAdmin) {
        return next(new ErrorResponse(
            'Priority 1 is reserved for SUPER_ADMIN',
            403
        ));
    }

    // Create role
    const role = await Role.create({
        name,
        description,
        organization: organizationId,
        priority,
        permissions: permissions || [],
        createdBy: req.user._id
    });

    console.log('✅ Role created:', {
        id: role._id,
        name: role.name,
        priority: role.priority,
        organization: organizationId,
        createdBy: req.user._id
    });

    // Get available modules; assignee action only for SUPER_ADMIN (reuse isSuperAdmin from above)
    const modulesRaw = await Module.find({ isActive: true })
        .select('name displayName description')
        .sort({ name: 1 })
        .lean();
    const modules = modulesRaw.map((m) => ({ ...m, actions: getActionsForModule(m.name, { includeAssignee: isSuperAdmin }) }));

    res.status(201).json({
        success: true,
        message: 'Role created successfully',
        data: {
            role: {
                id: role._id,
                name: role.name,
                description: role.description,
                priority: role.priority,
                permissions: role.permissions,
                isSystemRole: role.isSystemRole,
                organization: role.organization,
                createdBy: role.createdBy,
                createdAt: role.createdAt
            },
            modules
        }
    });
});

/**
 * @desc    Get all roles for organization
 * @route   GET /api/roles
 * @access  Private (Admin with role)
 */
exports.getRoles = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const currentUserRole = req.userRole; // Loaded by loadUserRole middleware

    // Build base query
    const query = { organization: organizationId };
    
    // Always exclude SUPER_ADMIN from role listing (it's created during setup and shouldn't be assignable)
    // SUPER_ADMIN can only be created during organization setup, not via invitation
    query.$or = [
        { priority: { $ne: 1 } },
        { isSystemRole: { $ne: true } }
    ];

    // Fetch all roles for this organization (excluding SUPER_ADMIN)
    const allRoles = await Role.find(query)
        .sort({ priority: 1 }); // Sort by priority ascending (1 = highest authority)

    // Apply visibility rules based on current user's role priority:
    // - SUPER_ADMIN (priority 1, isSystemRole true) can see all roles (already has allRoles)
    // - Other users should NOT see roles with higher authority (smaller priority number)
    //   e.g., priority 3 user should not see priority 1 or 2 roles
    let visibleRoles = allRoles;
    if (currentUserRole && currentUserRole.priority && !(currentUserRole.priority === 1 && currentUserRole.isSystemRole === true)) {
        const currentPriority = currentUserRole.priority;
        visibleRoles = allRoles.filter(role => role.priority >= currentPriority);
    }

    // Manually populate createdBy since it's a String ID, not ObjectId
    const rolesWithCreatedBy = await Promise.all(visibleRoles.map(async (role) => {
        const roleData = role.toObject();
        if (role.createdBy) {
            const createdByUser = await User.findById(role.createdBy)
                .select('firstName lastName email');
            if (createdByUser) {
                roleData.createdBy = createdByUser;
            }
        }
        return roleData;
    }));

    // Get available modules; assignee action only for SUPER_ADMIN
    const isSuperAdmin = currentUserRole && currentUserRole.priority === 1 && currentUserRole.isSystemRole === true;
    const modulesRaw = await Module.find({ isActive: true })
        .select('name displayName description')
        .sort({ name: 1 })
        .lean();
    const modules = modulesRaw.map((m) => ({ ...m, actions: getActionsForModule(m.name, { includeAssignee: isSuperAdmin }) }));

    res.status(200).json({
        success: true,
        count: rolesWithCreatedBy.length,
        data: rolesWithCreatedBy,
        modules
    });
});

/**
 * @desc    Get single role by ID
 * @route   GET /api/roles/:roleId
 * @access  Private (Admin with role)
 */
exports.getRole = asyncHandler(async (req, res, next) => {
    const { roleId } = req.params;
    const organizationId = req.user.organization;

    const role = await Role.findOne({
        _id: roleId,
        organization: organizationId
    });

    if (!role) {
        return next(new ErrorResponse('Role not found', 404));
    }

    // Manually fetch createdBy user since it's a String ID, not ObjectId
    let createdByUser = null;
    if (role.createdBy) {
        createdByUser = await User.findById(role.createdBy)
            .select('firstName lastName email');
    }

    // Convert role to object and add createdBy user data
    const roleData = role.toObject();
    if (createdByUser) {
        roleData.createdBy = createdByUser;
    }

    res.status(200).json({
        success: true,
        data: roleData
    });
});

/**
 * @desc    Update role (name, description, permissions only - priority is immutable)
 * @route   PUT /api/roles/:roleId
 * @access  Private (Admin with role that can manage target role)
 */
exports.updateRole = asyncHandler(async (req, res, next) => {
    const { roleId } = req.params;
    const { name, description, permissions } = req.body;
    const organizationId = req.user.organization;
    const updaterRole = req.userRole;

    // Get target role
    const role = await Role.findOne({
        _id: roleId,
        organization: organizationId
    });

    if (!role) {
        return next(new ErrorResponse('Role not found', 404));
    }

    // Validate permissions if provided
    if (permissions !== undefined) {
        const permissionValidation = await validatePermissions(permissions);
        if (!permissionValidation.valid) {
            return next(new ErrorResponse(permissionValidation.error, 400));
        }
        // Only SUPER_ADMIN can ADD assignee permission. Allow updating CRUD if role already had assignee.
        const isSuperAdminForAssignee = updaterRole.priority === 1 && updaterRole.isSystemRole === true;
        const permissionsWithAssignee = permissions.filter(
            (p) => (p.module === 'client' || p.module === 'cases') && (p.actions || []).includes('assignee')
        );
        const roleAlreadyHadAssignee = role.permissions.some(
            (p) => (p.module === 'client' || p.module === 'cases') && (p.actions || []).includes('assignee')
        );
        const isAddingAssignee = permissionsWithAssignee.length > 0 && !roleAlreadyHadAssignee;
        if (isAddingAssignee && !isSuperAdminForAssignee) {
            return next(new ErrorResponse('Only SUPER_ADMIN can grant assignee permission for client/cases', 403));
        }
        // If adding assignee to this role, enforce plan limit (both role count and user count)
        if (permissionsWithAssignee.length > 0) {
            const org = await Organization.findById(organizationId).select('subscriptionPlan').lean();
            const limit = getAssigneeLimit(org?.subscriptionPlan || 'free');

            // Block if adding assignee to a new role would exceed assignee ROLE limit
            if (!roleAlreadyHadAssignee) {
                const currentAssigneeRoleCount = await getAssigneeRoleCount(organizationId);
                if (currentAssigneeRoleCount >= limit) {
                    return next(new ErrorResponse(
                        `Assignee limit reached for your plan (${limit} assignee role(s), including SUPER_ADMIN). Current: ${currentAssigneeRoleCount}. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`,
                        400
                    ));
                }
            }

            // Block if users with this role would exceed assignee USER limit
            const currentCount = await getCurrentAssigneeCount(organizationId);
            const usersWithThisRole = await User.countDocuments({ organization: organizationId, role: role._id, status: { $nin: ['terminated'] } });
            const newAssigneesFromThisRole = roleAlreadyHadAssignee ? 0 : usersWithThisRole;
            if (currentCount + newAssigneesFromThisRole > limit) {
                return next(new ErrorResponse(
                    `Assignee limit reached for your plan (${limit} assignee(s), including SUPER_ADMIN). Current: ${currentCount}. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`,
                    400
                ));
            }
        }
    }

    // Update fields
    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;

    await role.save();

    console.log('✅ Role updated:', {
        id: role._id,
        name: role.name,
        priority: role.priority
    });

    res.status(200).json({
        success: true,
        message: 'Role updated successfully',
        data: role
    });
});

/**
 * @desc    Delete role
 * @route   DELETE /api/roles/:roleId
 * @access  Private (Admin with role that can manage target role)
 */
exports.deleteRole = asyncHandler(async (req, res, next) => {
    const { roleId } = req.params;
    const organizationId = req.user.organization;

    const role = await Role.findOne({
        _id: roleId,
        organization: organizationId
    });

    if (!role) {
        return next(new ErrorResponse('Role not found', 404));
    }

    // Prevent deleting SUPER_ADMIN role
    const isSuperAdmin = role.priority === 1 && role.isSystemRole === true;
    if (isSuperAdmin) {
        return next(new ErrorResponse('Cannot delete SUPER_ADMIN role', 403));
    }

    // Check if role is assigned to any users
    const usersWithRole = await User.countDocuments({ role: roleId });
    if (usersWithRole > 0) {
        return next(new ErrorResponse(
            `Cannot delete role. It is assigned to ${usersWithRole} user(s)`,
            400
        ));
    }

    await role.deleteOne();

    console.log('✅ Role deleted:', {
        id: roleId,
        name: role.name
    });

    res.status(200).json({
        success: true,
        message: 'Role deleted successfully'
    });
});

/**
 * @desc    Assign role to user
 * @route   POST /api/roles/:roleId/assign/:userId
 * @access  Private (Admin with role that can manage target role)
 */
exports.assignRoleToUser = asyncHandler(async (req, res, next) => {
    const { roleId, userId } = req.params;
    const organizationId = req.user.organization;

    // Get target role
    const role = await Role.findOne({
        _id: roleId,
        organization: organizationId
    });

    if (!role) {
        return next(new ErrorResponse('Role not found', 404));
    }

    // Get target user
    const user = await User.findOne({
        _id: userId,
        organization: organizationId
    });

    if (!user) {
        return next(new ErrorResponse('User not found', 404));
    }

    // Prevent assigning SUPER_ADMIN role (only created during setup)
    const isSuperAdmin = role.priority === 1 && role.isSystemRole === true;
    if (isSuperAdmin) {
        return next(new ErrorResponse('Cannot assign SUPER_ADMIN role', 403));
    }

    // Enforce assignee limit for ALL users including SUPER_ADMIN (plan limit applies to organization)
    if (roleHasAssigneePermission(role)) {
        const currentRoleId = user.role ? (typeof user.role === 'object' && user.role._id ? user.role._id : user.role) : null;
        const wasAlreadyAssignee = currentRoleId
            ? roleHasAssigneePermission(await Role.findById(currentRoleId).select('permissions').lean())
            : false;
        const { allowed, current, limit } = await checkAssigneeLimit(organizationId, wasAlreadyAssignee);
        if (!allowed) {
            return next(new ErrorResponse(
                `Assignee limit reached for your plan (${limit} assignee(s), including SUPER_ADMIN). Current assignees: ${current}. ${PROFESSIONAL_MONTHLY_UPGRADE_MESSAGE}`,
                400
            ));
        }
    }

    // Update user's role
    user.role = roleId;
    await user.save();

    console.log('✅ Role assigned to user:', {
        roleId: role._id,
        roleName: role.name,
        userId: user._id,
        userEmail: user.email
    });

    res.status(200).json({
        success: true,
        message: 'Role assigned successfully',
        data: {
            user: {
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: roleId
            },
            role: {
                id: role._id,
                name: role.name,
                priority: role.priority
            }
        }
    });
});
