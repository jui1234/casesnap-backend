// routes/subscriptionRoutes.js

const express = require('express');
const router = express.Router();
const {
    getSubscriptions,
    getSubscription,
    getOrganizationSubscription,
    createSubscription,
    updateSubscription,
    deleteSubscription,
    renewSubscription,
    getSubscriptionStats
} = require('../controllers/subscriptionController');

const { protect } = require('../middleware/auth');
const { loadUserRole, checkPermission } = require('../middleware/rbac');

// All subscription routes require authentication and permission check
router.use(protect);
router.use(loadUserRole);

// Subscription CRUD routes with permission-based access control
// Special routes must come before parameter routes to avoid conflicts
router.get('/stats/overview', checkPermission('subscription', 'read'), getSubscriptionStats);
router.get('/org/:organizationId', checkPermission('subscription', 'read'), getOrganizationSubscription);
router.post('/:id/renew', checkPermission('subscription', 'update'), renewSubscription);

// Generic routes
router.get('/', checkPermission('subscription', 'read'), getSubscriptions);
router.post('/', checkPermission('subscription', 'create'), createSubscription);
router.get('/:id', checkPermission('subscription', 'read'), getSubscription);
router.put('/:id', checkPermission('subscription', 'update'), updateSubscription);
router.delete('/:id', checkPermission('subscription', 'delete'), deleteSubscription);

module.exports = router;
