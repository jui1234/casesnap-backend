// middleware/auth.js

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ErrorResponse = require('../utils/errorResponse');
const { validateOrganizationSubscription } = require('../utils/subscriptionUtils');
const { getSubscriptionSummary } = require('../utils/subscriptionFeatureUtils');

// Protect routes (optional - doesn't fail if no token)
// Used for public routes that can optionally check authorization if user is authenticated
exports.protectOptional = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        // Set token from Bearer token in header
        token = req.headers.authorization.split(' ')[1];
    }

    // If no token, continue without setting req.user (for public routes with optional auth)
    if (!token) {
        return next();
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        console.log('🔐 Optional auth - Token verified for user:', decoded.id);

        // Check if it's an employee or admin user based on role in token
        if (decoded.role === 'employee') {
            // Get employee from token
            req.user = await Employee.findById(decoded.id).populate('organization');
            req.userType = 'employee';
        } else {
            // Get admin user from token
            req.user = await User.findById(decoded.id).populate('organization');
            req.userType = 'admin';
        }

        if (!req.user) {
            // Don't fail, just continue without req.user
            console.log('⚠️ User not found with token, continuing without authentication');
        } else {
            if (req.user.organization) {
                req.user.organization.subscriptionInfo = getSubscriptionSummary(req.user.organization);
            }
            console.log('✅ Optional auth - User authenticated:', req.user.email);
        }

        next();
    } catch (err) {
        console.log('⚠️ Token verification failed, continuing without authentication:', err.message);
        // Don't fail, just continue without req.user
        next();
    }
};

// Protect routes
exports.protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        // Set token from Bearer token in header
        token = req.headers.authorization.split(' ')[1];
    }

    // Make sure token exists
    if (!token) {
        return next(new ErrorResponse('Not authorized to access this route', 401));
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        console.log('🔐 Token verified for user:', decoded.id);

        // Check if it's an employee or admin user based on role in token
        if (decoded.role === 'employee') {
            // Get employee from token
            req.user = await Employee.findById(decoded.id).populate('organization');
            req.userType = 'employee';
        } else {
            // Get admin user from token
            req.user = await User.findById(decoded.id).populate('organization');
            req.userType = 'admin';
        }

        if (!req.user) {
            return next(new ErrorResponse('No user found with this token', 401));
        }

        if (req.user.organization) {
            req.user.organization.subscriptionInfo = getSubscriptionSummary(req.user.organization);
        }

        // Enforce subscription status/expiry for every protected request
        const subscriptionCheck = validateOrganizationSubscription(req.user.organization);
        if (!subscriptionCheck.valid) {
            return next(new ErrorResponse(subscriptionCheck.reason, 403));
        }

        next();
    } catch (err) {
        console.error('❌ Token verification failed:', err.message);
        return next(new ErrorResponse('Not authorized to access this route', 401));
    }
};

exports.protectAllowExpiredSuperAdmin = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        // Set token from Bearer token in header
        token = req.headers.authorization.split(' ')[1];
    }

    // Make sure token exists
    if (!token) {
        return next(new ErrorResponse('Not authorized to access this route', 401));
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        console.log('🔐 Token verified for user:', decoded.id);

        if (decoded.role === 'employee') {
            req.user = await Employee.findById(decoded.id).populate('organization');
            req.userType = 'employee';
        } else {
            req.user = await User.findById(decoded.id)
                .populate('organization')
                .populate({ path: 'role', select: 'priority isSystemRole' });
            req.userType = 'admin';
        }

        if (!req.user) {
            return next(new ErrorResponse('No user found with this token', 401));
        }

        if (req.user.organization) {
            req.user.organization.subscriptionInfo = getSubscriptionSummary(req.user.organization);
        }

        const subscriptionCheck = validateOrganizationSubscription(req.user.organization);
        if (!subscriptionCheck.valid) {
            const expiredMessage = 'Your subscription plan has expired. Please renew your plan to continue.';
            if (subscriptionCheck.reason === expiredMessage) {
                const isSuperAdmin = req.userType === 'admin' && req.user.role && req.user.role.priority === 1 && req.user.role.isSystemRole === true;
                if (!isSuperAdmin) {
                    return next(new ErrorResponse(subscriptionCheck.reason, 403));
                }
                req.subscriptionExpired = true;
                return next();
            }
            return next(new ErrorResponse(subscriptionCheck.reason, 403));
        }

        next();
    } catch (err) {
        console.error('❌ Token verification failed:', err.message);
        return next(new ErrorResponse('Not authorized to access this route', 401));
    }
};

// Grant access to specific roles
exports.authorize = (...roles) => {
    return (req, res, next) => {
        // For employees, check userType, for admins check role
        const userRole = req.userType === 'employee' ? 'employee' : req.user.role;
        
        if (!roles.includes(userRole)) {
            return next(new ErrorResponse(`User role ${userRole} is not authorized to access this route`, 403));
        }
        next();
    };
};
