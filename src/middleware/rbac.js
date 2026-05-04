// middleware/rbac.js
// Role-Based Access Control middleware

const ErrorResponse = require('../utils/errorResponse');
const Role = require('../models/Role');
const User = require('../models/User');
const { getAssigneePermissionsForRole, canAssignModule } = require('../utils/assigneeUtils');

/**
 * Middleware to ensure user has a role and load it
 * Must be used after protect middleware
 * Only works for User (admin) accounts, not Employee accounts
 */
exports.loadUserRole = async (req, res, next) => {
    try {
        // Ensure user is authenticated
        if (!req.user) {
            return next(new ErrorResponse('User not authenticated', 401));
        }

        // This middleware only works for User (admin) accounts, not Employee accounts
        // Try to find the user in the User model (will fail if it's an Employee)
        let user = await User.findById(req.user._id);
        
        if (!user) {
            return next(new ErrorResponse('This route is only accessible by admin users, not employees.', 403));
        }

        // Check if role is already populated
        if (user.role && typeof user.role === 'object' && user.role.name) {
            // Role is already populated
            req.userRole = user.role;
        } else {
            // Role is not populated, populate it
            await user.populate({
                path: 'role',
                select: 'name priority permissions isSystemRole description'
            });
            
            // Ensure virtuals are available
            if (user.role && typeof user.role.toObject === 'function') {
                user.role = user.role.toObject({ virtuals: true });
            }
            
            if (!user.role) {
                return next(new ErrorResponse('User does not have a role assigned', 403));
            }
            
            req.userRole = user.role;
        }

        // Update req.user with populated role
        req.user = user;

        next();
    } catch (error) {
        console.error('❌ Error loading user role:', error.message);
        return next(new ErrorResponse('Error loading user role', 500));
    }
};

/**
 * Middleware to check if user's role can manage a target role
 * Used when creating/editing/deleting roles
 */
exports.canManageRole = async (req, res, next) => {
    try {
        if (!req.userRole) {
            return next(new ErrorResponse('User role not loaded', 500));
        }

        const targetRoleId = req.params.roleId || req.body.roleId;
        
        if (!targetRoleId) {
            // For role creation, check if user can create roles
            // User can create roles with priority higher than their own
            return next(); // Will be validated in controller
        }

        // Load target role
        const targetRole = await Role.findById(targetRoleId);
        
        if (!targetRole) {
            return next(new ErrorResponse('Target role not found', 404));
        }

        // Ensure target role belongs to same organization
        if (targetRole.organization.toString() !== req.user.organization.toString()) {
            return next(new ErrorResponse('Cannot manage roles from other organizations', 403));
        }

        // SUPER_ADMIN can manage all roles
        const isSuperAdmin = req.userRole.priority === 1 && req.userRole.isSystemRole === true;
        
        if (!isSuperAdmin) {
            // Check if user's role can manage target role
            if (!req.userRole.canManageRole(targetRole)) {
                return next(new ErrorResponse(
                    `Your role (priority ${req.userRole.priority}) cannot manage roles with priority ${targetRole.priority} or lower`,
                    403
                ));
            }
        }

        req.targetRole = targetRole;
        next();
    } catch (error) {
        console.error('❌ Error checking role management permission:', error.message);
        return next(new ErrorResponse('Error checking role permissions', 500));
    }
};

/**
 * Middleware to check permission for a specific module and action
 * Usage: checkPermission('employee', 'create')
 * SUPER_ADMIN (priority 1, isSystemRole true) bypasses all permission checks
 */
exports.checkPermission = (module, action) => {
    return async (req, res, next) => {
        try {
            if (!req.userRole) {
                return next(new ErrorResponse('User role not loaded', 500));
            }

            // SUPER_ADMIN bypasses all permission checks
            // Check if role is SUPER_ADMIN (priority 1 and isSystemRole true)
            const isSuperAdmin = req.userRole.priority === 1 && req.userRole.isSystemRole === true;
            if (isSuperAdmin) {
                console.log('✅ SUPER_ADMIN bypassing permission check for', module, action);
                return next();
            }

            // Check if role has permission
            if (!req.userRole.hasPermission(module, action)) {
                return next(new ErrorResponse(
                    `You do not have permission to ${action} ${module}`,
                    403
                ));
            }

            next();
        } catch (error) {
            console.error('❌ Error checking permission:', error.message);
            return next(new ErrorResponse('Error checking permissions', 500));
        }
    };
};

/**
 * Middleware to check if user is SUPER_ADMIN
 */
exports.isSuperAdmin = async (req, res, next) => {
    try {
        if (!req.userRole) {
            return next(new ErrorResponse('User role not loaded', 500));
        }

        if (!req.userRole.isSuperAdmin) {
            return next(new ErrorResponse('Only SUPER_ADMIN can access this route', 403));
        }

        next();
    } catch (error) {
        console.error('❌ Error checking SUPER_ADMIN status:', error.message);
        return next(new ErrorResponse('Error checking admin status', 500));
    }
};

/**
 * Middleware: allow only users who have assignee permission (canAssignClient or canAssignCase).
 * Used for GET /api/users/assignable so only assignees can see the full list for client/case assignment.
 */
/**
 * Bulk assign clients: allowed for SUPER_ADMIN and roles with `assignee` on the `client` module.
 * Use after `checkPermission('client', 'read')` (or equivalent) so SUPER_ADMIN still bypasses read.
 */
exports.requireClientBulkAssignAccess = async (req, res, next) => {
    try {
        if (!req.userRole) {
            return next(new ErrorResponse('User role not loaded', 500));
        }
        if (!canAssignModule(req.userRole, 'client')) {
            return next(new ErrorResponse(
                'You do not have permission to bulk assign clients. Only SUPER_ADMIN or users with client assignee permission can use this.',
                403
            ));
        }
        next();
    } catch (error) {
        console.error('❌ Error checking bulk client assign access:', error.message);
        return next(new ErrorResponse('Error checking permissions', 500));
    }
};

exports.requireAssignableListAccess = async (req, res, next) => {
    try {
        if (!req.userRole) {
            return next(new ErrorResponse('User role not loaded', 500));
        }
        const perms = getAssigneePermissionsForRole(req.userRole);
        if (!perms.canAssignClient && !perms.canAssignCase) {
            return next(new ErrorResponse(
                'You do not have permission to view the assignable users list. Only users with assignee permission (client or cases) can access this.',
                403
            ));
        }
        next();
    } catch (error) {
        console.error('❌ Error checking assignable list access:', error.message);
        return next(new ErrorResponse('Error checking assignable list access', 500));
    }
};

/**
 * Middleware to ensure user belongs to the same organization as the resource
 */
exports.sameOrganization = async (req, res, next) => {
    try {
        if (!req.user || !req.user.organization) {
            return next(new ErrorResponse('User organization not found', 500));
        }

        // Get organization ID from params or body
        const resourceOrgId = req.params.organizationId || req.body.organizationId || req.query.organizationId;
        
        if (resourceOrgId && resourceOrgId.toString() !== req.user.organization.toString()) {
            return next(new ErrorResponse('Access denied: Different organization', 403));
        }

        next();
    } catch (error) {
        console.error('❌ Error checking organization:', error.message);
        return next(new ErrorResponse('Error checking organization access', 500));
    }
};
