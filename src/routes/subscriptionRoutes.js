// routes/subscriptionRoutes.js

const express = require('express');
const router = express.Router();
const {
    getOrganizationSubscription,
    getCurrentSubscription,
    getSubscriptionPlans,
    assignSubscriptionPlanToOrganization
} = require('../controllers/subscriptionController');

const { protectAllowExpiredSuperAdmin } = require('../middleware/auth');
const { loadUserRole, checkPermission } = require('../middleware/rbac');

// All subscription routes require authentication and permission check
router.use(protectAllowExpiredSuperAdmin);

// Current organization subscription details available to any authenticated user
router.get('/current', getCurrentSubscription);

// Subscription plan list available to any authenticated user
router.get('/plans', getSubscriptionPlans);

// Admin-only subscription assignment routes
router.use(loadUserRole);

router.put('/organizations/:organizationId/assign', checkPermission('subscription', 'update'), assignSubscriptionPlanToOrganization);
router.post('/organizations/:organizationId/assign', checkPermission('subscription', 'update'), assignSubscriptionPlanToOrganization);
router.get('/org/:organizationId', checkPermission('subscription', 'read'), getOrganizationSubscription);

module.exports = router;

module.exports = router;
