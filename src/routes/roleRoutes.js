// routes/roleRoutes.js

const express = require('express');
const router = express.Router();
const {
    getSuggestedPriority,
    createRole,
    getRoles,
    getRole,
    updateRole,
    deleteRole,
    assignRoleToUser
} = require('../controllers/roleController');

const { protect } = require('../middleware/auth');
const { loadUserRole, canManageRole, checkPermission } = require('../middleware/rbac');
const { checkRoleLimit } = require('../middleware/subscriptionLimits');

// All routes require authentication and role loading
router.use(protect);
router.use(loadUserRole);

// Get suggested priority (requires role management permission)
router.get('/suggest-priority', getSuggestedPriority);

// Get all roles (requires read permission on 'role' module)
router.get('/', checkPermission('role', 'read'), getRoles);

// Get single role (requires read permission on 'role' module)
router.get('/:roleId', checkPermission('role', 'read'), getRole);

// Create role (requires create permission on 'role' module)
router.post(
    '/',
    checkPermission('role', 'create'),
    checkRoleLimit,
    createRole
);

// Update role (requires update permission on 'role' module and ability to manage target role)
router.put(
    '/:roleId',
    checkPermission('role', 'update'),
    canManageRole,
    updateRole
);

// Delete role (requires delete permission on 'role' module and ability to manage target role)
router.delete(
    '/:roleId',
    checkPermission('role', 'delete'),
    canManageRole,
    deleteRole
);

// Assign role to user (requires update permission on 'user' module and ability to manage target role)
router.post(
    '/:roleId/assign/:userId',
    checkPermission('user', 'update'),
    canManageRole,
    assignRoleToUser
);

module.exports = router;
