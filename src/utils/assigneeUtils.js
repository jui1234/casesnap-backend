// utils/assigneeUtils.js
// Assignee permission limits by subscription plan (only SUPER_ADMIN can grant assignee)
// Assignee = user who can assign clients/cases to other users (client/cases modules)

const User = require('../models/User');
const Role = require('../models/Role');
const Organization = require('../models/Organization');
const { getPlanLimits, normalizePlanName } = require('./subscriptionFeatureUtils');

/**
 * Get max assignees allowed for a subscription plan
 * @param {string} plan
 * @returns {number|null}
 */
exports.getAssigneeLimit = (plan) => {
    const limits = getPlanLimits(normalizePlanName(plan || 'free'));
    return limits.maxAssignees === undefined ? 2 : limits.maxAssignees;
};

const isSuperAdminRole = (role) =>
    role && role.priority === 1 && role.isSystemRole === true;

/**
 * Check if a role has assignee permission (on client or cases module)
 * @param {Object} role - Role doc or plain object with permissions
 * @returns {boolean}
 */
exports.roleHasAssigneePermission = (role) => {
    if (!role || !Array.isArray(role.permissions)) return false;
    return role.permissions.some(
        (p) => (p.module === 'client' || p.module === 'cases') && (p.actions || []).includes('assignee')
    );
};

/**
 * Get assignee permissions per module for frontend (who can assign client/case to other users).
 * SUPER_ADMIN by default can assign client and case; others need assignee in role permissions.
 * @param {Object} role - Role doc or plain object with permissions
 * @returns {{ canAssignClient: boolean, canAssignCase: boolean }}
 */
exports.getAssigneePermissionsForRole = (role) => {
    const out = { canAssignClient: false, canAssignCase: false };
    if (!role) return out;
    if (isSuperAdminRole(role)) return { canAssignClient: true, canAssignCase: true };
    if (!Array.isArray(role.permissions)) return out;
    for (const p of role.permissions) {
        const actions = p.actions || [];
        if (actions.includes('assignee')) {
            if (p.module === 'client') out.canAssignClient = true;
            if (p.module === 'cases') out.canAssignCase = true;
        }
    }
    return out;
};

/** Check if user/role can assign (SUPER_ADMIN or has assignee permission on module) */
exports.canAssignModule = (userRole, moduleName) => {
    if (!userRole) return false;
    if (isSuperAdminRole(userRole)) return true;
    return userRole.hasPermission ? userRole.hasPermission(moduleName, 'assignee') : false;
};

/**
 * Count roles that can assign (for plan limit when creating roles).
 * Includes SUPER_ADMIN because free plan allows 2 assignees including super admin.
 * @param {string} organizationId
 * @returns {Promise<number>}
 */
exports.getAssigneeRoleCount = async (organizationId) => {
    return Role.countDocuments({
        organization: organizationId,
        $or: [
            { priority: 1, isSystemRole: true },
            { 'permissions': { $elemMatch: { module: 'client', actions: 'assignee' } } },
            { 'permissions': { $elemMatch: { module: 'cases', actions: 'assignee' } } }
        ]
    });
};

/**
 * Count distinct users in the organization who have assignee permission (for plan limit).
 * Includes SUPER_ADMIN because free plan allows 2 assignees including super admin.
 * @param {string} organizationId
 * @returns {Promise<number>}
 */
exports.getCurrentAssigneeCount = async (organizationId) => {
    const assigneeRoles = await Role.find({
        organization: organizationId,
        $or: [
            { priority: 1, isSystemRole: true },
            { 'permissions': { $elemMatch: { module: 'client', actions: 'assignee' } } },
            { 'permissions': { $elemMatch: { module: 'cases', actions: 'assignee' } } }
        ]
    })
        .select('_id')
        .lean();

    const ids = assigneeRoles.map((r) => r._id);
    if (ids.length === 0) return 0;

    return User.countDocuments({
        organization: organizationId,
        role: { $in: ids },
        status: { $nin: ['terminated'] }
    });
};

/**
 * Get user IDs in the organization who have assignee permission for a module (for notifications).
 * Includes SUPER_ADMIN. Used to notify assignees when a non-assignee creates a client/case.
 * @param {string} organizationId
 * @param {string} moduleName - 'client' | 'cases'
 * @returns {Promise<string[]>} Array of user _id
 */
exports.getAssigneeUserIdsForModule = async (organizationId, moduleName) => {
    const module = (moduleName || 'client').toLowerCase();
    const assigneeRoles = await Role.find({
        organization: organizationId,
        $or: [
            { priority: 1, isSystemRole: true },
            { 'permissions': { $elemMatch: { module, actions: 'assignee' } } }
        ]
    })
        .select('_id')
        .lean();

    const roleIds = assigneeRoles.map((r) => r._id);
    if (roleIds.length === 0) return [];

    const users = await User.find({
        organization: organizationId,
        role: { $in: roleIds },
        status: 'approved'
    })
        .select('_id')
        .lean();

    return users.map((u) => u._id.toString());
};

/**
 * Check if adding one more assignee would exceed plan limit
 * @param {string} organizationId
 * @param {boolean} [isAlreadyAssignee] - if the user being added is already an assignee (e.g. role change)
 * @returns {Promise<{ allowed: boolean, current: number, limit: number|null }>}
 */
exports.checkAssigneeLimit = async (organizationId, isAlreadyAssignee = false) => {
    const org = await Organization.findById(organizationId).select('subscriptionPlan').lean();
    const plan = org?.subscriptionPlan || 'free';
    const limit = exports.getAssigneeLimit(plan);
    const current = await exports.getCurrentAssigneeCount(organizationId);
    if (limit === null || limit === undefined) {
        return { allowed: true, current, limit };
    }
    const effectiveNew = isAlreadyAssignee ? 0 : 1;
    const allowed = current + effectiveNew <= limit;
    return { allowed, current, limit };
};

/**
 * Case/client assignedTo must be an approved member (pending = invited, not onboarded yet).
 * @returns {Promise<null | { assignedTo: string } | { error: string }>}
 */
exports.assertAssignableUserInOrg = async (organizationId, assignedTo) => {
    if (assignedTo === undefined || assignedTo === null || String(assignedTo).trim() === '') {
        return null;
    }
    const targetId = String(assignedTo).trim();
    const assigneeUser = await User.findOne({
        _id: targetId,
        organization: organizationId,
        status: 'approved'
    })
        .select('_id')
        .lean();
    if (!assigneeUser) {
        return {
            error:
                'Assignee not found or not eligible. Only approved organization members can receive client/case assignments (pending onboarding or inactive accounts cannot be assigned)'
        };
    }
    return { assignedTo: targetId };
};
