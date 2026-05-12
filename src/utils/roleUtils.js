// utils/roleUtils.js
// Utility functions for role management

const Role = require('../models/Role');
const Module = require('../models/Module');

/**
 * Get the next suggested priority for a new role in an organization
 * @param {String} organizationId - Organization ID
 * @returns {Promise<Number>} Suggested priority (highest existing priority + 1)
 */
exports.getSuggestedPriority = async (organizationId) => {
    try {
        // Find the role with highest priority in the organization
        const highestPriorityRole = await Role.findOne({ organization: organizationId })
            .sort({ priority: -1 })
            .select('priority')
            .lean();

        if (!highestPriorityRole) {
            // No roles exist yet, suggest priority 2 (1 is reserved for SUPER_ADMIN)
            return 2;
        }

        // Suggest next priority (highest + 1)
        return highestPriorityRole.priority + 1;
    } catch (error) {
        console.error('❌ Error getting suggested priority:', error.message);
        throw error;
    }
};

/**
 * Validate that a user can create a role with the given priority
 * @param {Object} userRole - User's role object
 * @param {Number} newPriority - Priority of the role being created
 * @returns {Object} { valid: boolean, error: string }
 */
exports.validateRoleCreation = (userRole, newPriority) => {
    // SUPER_ADMIN (priority 1 and isSystemRole true) can create any role
    const isSuperAdmin = userRole.priority === 1 && userRole.isSystemRole === true;
    if (isSuperAdmin) {
        return { valid: true };
    }

    // User can only create roles with higher priority (lower authority)
    if (userRole.priority >= newPriority) {
        return {
            valid: false,
            error: `You can only create roles with priority higher than ${userRole.priority}. Requested priority: ${newPriority}`
        };
    }

    return { valid: true };
};

/** Base actions for all modules; assignee only for client and cases */
const MODULES_WITH_ASSIGNEE = ['client', 'cases'];
const BASE_ACTIONS = ['create', 'read', 'update', 'delete'];
const ASSIGNEE_ACTION = 'assignee';

/**
 * Get allowed actions for a module (for API response).
 * Assignee is included for `client` / `cases` when any of:
 * - `includeAssignee: true` (SUPER_ADMIN in role UI), or
 * - `assigneeClient: true` / `assigneeCases: true` per module (e.g. GET /api/modules for current user).
 * @param {string} moduleName - e.g. 'client', 'cases', 'role', 'user'
 * @param {{
 *   includeAssignee?: boolean,
 *   assigneeClient?: boolean,
 *   assigneeCases?: boolean
 * }} [options]
 * @returns {string[]}
 */
exports.getActionsForModule = (moduleName, options = {}) => {
    const name = (moduleName || '').toLowerCase().trim();
    const superInclude = options.includeAssignee === true;
    let showAssignee = false;
    if (MODULES_WITH_ASSIGNEE.includes(name)) {
        if (superInclude) {
            showAssignee = true;
        } else if (name === 'client' && options.assigneeClient === true) {
            showAssignee = true;
        } else if (name === 'cases' && options.assigneeCases === true) {
            showAssignee = true;
        }
    }
    if (showAssignee) {
        return [...BASE_ACTIONS, ASSIGNEE_ACTION];
    }
    return [...BASE_ACTIONS];
};

/**
 * Get effective permissions for a role to return to frontend.
 * SUPER_ADMIN always gets full permissions for all active modules (even if stored permissions
 * are empty, e.g. from setup when Module collection was empty). Other roles use stored permissions.
 * @param {Object} role - Role object with priority, isSystemRole, permissions
 * @returns {Promise<Array>} Permissions array for frontend
 */
exports.getEffectivePermissionsForRole = async (role) => {
    if (!role) return [];
    const isSuperAdmin = role.priority === 1 && role.isSystemRole === true;
    if (isSuperAdmin) {
        const moduleNames = await exports.getActiveModules();
        const DEFAULT_MODULES = ['client', 'cases', 'role', 'user'];
        const modules = moduleNames.length > 0 ? moduleNames : DEFAULT_MODULES;
        return modules.map(name => {
            const baseActions = ['create', 'read', 'update', 'delete'];
            const actions = MODULES_WITH_ASSIGNEE.includes(name)
                ? [...baseActions, 'assignee']
                : baseActions;
            return { module: name, actions };
        });
    }
    return role.permissions || [];
};

/**
 * Get all active modules from database
 * @returns {Promise<Array>} Array of module names
 */
exports.getActiveModules = async () => {
    try {
        const modules = await Module.find({ isActive: true })
            .select('name displayName')
            .lean();
        return modules.map(m => m.name);
    } catch (error) {
        console.error('❌ Error getting active modules:', error.message);
        // Fallback to default modules if database query fails
        return ['client', 'cases'];
    }
};

/**
 * Validate permissions structure
 * @param {Array} permissions - Array of permission objects
 * @returns {Promise<Object>} { valid: boolean, error: string }
 */
exports.validatePermissions = async (permissions) => {
    if (!Array.isArray(permissions)) {
        return { valid: false, error: 'Permissions must be an array' };
    }

    // Get valid modules from database
    const validModules = await exports.getActiveModules();
    const baseActions = BASE_ACTIONS;
    const modulesWithAssignee = MODULES_WITH_ASSIGNEE;

    const seenModules = new Set();

    for (const permission of permissions) {
        // Normalize module name to lowercase
        const moduleName = permission.module ? permission.module.toLowerCase().trim() : null;
        
        // Check module
        if (!moduleName || !validModules.includes(moduleName)) {
            return {
                valid: false,
                error: `Invalid module: ${permission.module}. Must be one of: ${validModules.join(', ')}`
            };
        }

        // Check for duplicate modules
        if (seenModules.has(moduleName)) {
            return {
                valid: false,
                error: `Duplicate module: ${permission.module}`
            };
        }
        seenModules.add(moduleName);

        // Check actions
        if (!permission.actions || !Array.isArray(permission.actions) || permission.actions.length === 0) {
            return {
                valid: false,
                error: `Module ${permission.module} must have at least one action`
            };
        }

        const validActions = modulesWithAssignee.includes(moduleName)
            ? [...baseActions, 'assignee']
            : baseActions;

        // Validate each action
        for (const action of permission.actions) {
            if (!validActions.includes(action)) {
                return {
                    valid: false,
                    error: action === 'assignee'
                        ? `Action 'assignee' is only allowed for client and cases modules`
                        : `Invalid action: ${action} for module ${permission.module}. Must be one of: ${validActions.join(', ')}`
                };
            }
        }
    }

    return { valid: true };
};
