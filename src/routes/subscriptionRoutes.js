// routes/subscriptionRoutes.js

const express = require('express');
const router = express.Router();
const {
    getOrganizationSubscription,
    getCurrentSubscription,
    getSubscriptionPlans,
    assignSubscriptionPlanToOrganization
} = require('../controllers/subscriptionController');

const { protectAllowExpiredSuperAdmin, protectOptional } = require('../middleware/auth');
const { loadUserRole, checkPermission } = require('../middleware/rbac');

// Subscription plan list is public so it can be used during organization setup.
// If a valid token is sent, the controller will also mark the current plan.
router.get('/plans', protectOptional, getSubscriptionPlans);

// Remaining subscription routes require authentication.
router.use(protectAllowExpiredSuperAdmin);

// Current organization subscription details available to any authenticated user
router.get('/current', getCurrentSubscription);

// Admin-only subscription assignment routes
router.use(loadUserRole);

router.put('/organizations/:organizationId/assign', checkPermission('subscription', 'update'), assignSubscriptionPlanToOrganization);
router.post('/organizations/:organizationId/assign', checkPermission('subscription', 'update'), assignSubscriptionPlanToOrganization);
router.get('/org/:organizationId', checkPermission('subscription', 'read'), getOrganizationSubscription);

module.exports = router;
