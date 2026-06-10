// controllers/authController.js

const User = require('../models/User'); // Import our User model
const Employee = require('../models/Employee'); // Import Employee model
const asyncHandler = require('../middleware/asyncHandler'); // We'll create this next for error handling
const ErrorResponse = require('../utils/errorResponse'); // We'll create this too
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getAssigneePermissionsForRole } = require('../utils/assigneeUtils');
const { getEffectivePermissionsForRole } = require('../utils/roleUtils');
const { validateOrganizationSubscription } = require('../utils/subscriptionUtils');
const { getSubscriptionSummary } = require('../utils/subscriptionFeatureUtils');
const { sendPasswordResetEmail } = require('../utils/gmailService');

// @desc      Login user (Admin or Employee)
// @route     POST /api/auth/login
// @access    Public
exports.login = asyncHandler(async (req, res, next) => {
    const { email, password } = req.body;

    // 1. Validate email and password
    if (!email || !password) {
        return next(new ErrorResponse('Please provide an email and password', 400));
    }

    console.log('🔐 Attempting login for:', email);

    // 2. First try to find admin user
    let user = await User.findOne({ email: email.toLowerCase() })
        .select('+password');
    let userType = 'admin';
    
    // Populate role and organization after finding the user
    if (user) {
        await user.populate({
            path: 'role',
            select: 'name priority permissions isSystemRole description'
        });
        await user.populate('organization', 'companyName companyEmail _id subscriptionPlan subscriptionStatus subscriptionExpiresAt');
    }

    // 3. If no admin user found, try to find employee
    if (!user) {
        user = await Employee.findOne({ email: email.toLowerCase() })
            .select('+password')
            .populate('organization', 'companyName companyEmail _id subscriptionPlan subscriptionStatus subscriptionExpiresAt');
        userType = 'employee';
    }

    if (!user) {
        return next(new ErrorResponse('Invalid credentials', 401));
    }

    // 4. Check if password is set (for employees who haven't completed registration)
    if (!user.password) {
        return next(new ErrorResponse('Password not set. Please complete your registration.', 401));
    }

    // 5. Check if password matches
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
        return next(new ErrorResponse('Invalid credentials', 401));
    }

    // 6. Check if employee is active (only for employees)
    if (userType === 'employee') {
        if (user.status !== 'active') {
            return next(new ErrorResponse('User is not active', 401));
        }
    }

    // 6b. Check if admin user is approved (only for admin users)
    if (userType === 'admin') {
        if (user.status !== 'approved') {
            return next(new ErrorResponse('Your account is pending approval. Please wait for admin approval before logging in.', 401));
        }
    }

    // 6c. Subscription validation (blocked if expired/inactive/cancelled)
    const subscriptionCheck = validateOrganizationSubscription(user.organization);
    if (!subscriptionCheck.valid) {
        // If subscription specifically expired, include canManageSubscription flag with user details
        const expiredMessage = 'Your subscription plan has expired. Please renew your plan to continue.';
        if (subscriptionCheck.reason === expiredMessage) {
            // Determine if the user is a SUPER_ADMIN (priority 1 and system role)
            let isSuperAdmin = false;
            if (userType === 'admin') {
                if (user.role && typeof user.role === 'object' && user.role.priority !== undefined && user.role.isSystemRole !== undefined) {
                    isSuperAdmin = (user.role.priority === 1 && user.role.isSystemRole === true);
                } else {
                    // Role might be stored as an id/string — attempt to load minimal role info
                    const Role = require('../models/Role');
                    let roleId = user.role;
                    if (Buffer.isBuffer(roleId)) roleId = roleId.toString('hex');
                    if (typeof roleId === 'string' && roleId) {
                        const role = await Role.findById(roleId).select('priority isSystemRole');
                        if (role) isSuperAdmin = (role.priority === 1 && role.isSystemRole === true);
                    }
                }
            }

            // Create token for subscription expired response (same as successful login)
            let respRoleId = userType;
            if (userType === 'admin' && user.role) {
                if (typeof user.role === 'object' && user.role._id) {
                    respRoleId = user.role._id;
                } else if (typeof user.role === 'string') {
                    respRoleId = user.role;
                } else if (Buffer.isBuffer(user.role)) {
                    respRoleId = user.role.toString('hex');
                }
            }
            
            const tokenPayload = {
                id: user._id,
                email: user.email,
                organization: user.organization?._id || user.organization,
                role: respRoleId
            };
            
            const expiredToken = jwt.sign(
                tokenPayload,
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRE || '30d' }
            );

            if (!isSuperAdmin) {
                return res.status(403).json({
                    success: false,
                    error: subscriptionCheck.reason
                });
            }

            // Only build full login-like response when user can manage subscription
            const subscriptionSummary = getSubscriptionSummary(user.organization);
            let userData;
            if (userType === 'employee') {
                userData = {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    phone: user.phone,
                    address: user.address,
                    gender: user.gender,
                    dateOfBirth: user.dateOfBirth,
                    age: user.age,
                    aadharCardNumber: user.aadharCardNumber,
                    employeeType: user.employeeType,
                    advocateLicenseNumber: user.advocateLicenseNumber,
                    internYear: user.internYear,
                    salary: user.salary,
                    department: user.department,
                    position: user.position,
                    startDate: user.startDate,
                    emergencyContactName: user.emergencyContactName,
                    emergencyContactPhone: user.emergencyContactPhone,
                    emergencyContactRelation: user.emergencyContactRelation,
                    organization: user.organization,
                    adminId: user.adminId,
                    status: user.status,
                    role: 'employee',
                    subscriptionPlan: subscriptionSummary.subscriptionPlan,
                    subscriptionLabel: subscriptionSummary.subscriptionLabel,
                    subscriptionStatus: subscriptionSummary.subscriptionStatus,
                    subscriptionExpiresAt: subscriptionSummary.subscriptionExpiresAt,
                    subscriptionFeatures: subscriptionSummary.subscriptionFeatures,
                    subscriptionFeatureFlags: subscriptionSummary.subscriptionFeatureFlags,
                    subscriptionLimits: subscriptionSummary.subscriptionLimits,
                    createdAt: user.createdAt
                };
            } else {
                // Ensure role is populated for admin users
                if (user.role && (!user.role.name || typeof user.role === 'string' || Buffer.isBuffer(user.role))) {
                    const Role = require('../models/Role');
                    let roleId = user.role;
                    if (Buffer.isBuffer(roleId)) {
                        roleId = roleId.toString('hex');
                    } else if (typeof roleId === 'object' && roleId.toString) {
                        roleId = roleId.toString();
                    }
                    if (roleId) {
                        const role = await Role.findById(roleId);
                        if (role) {
                            user.role = role;
                        }
                    }
                }

                userData = {
                    id: user._id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    organizationId: user.organization?._id || user.organization || null,
                    subscriptionPlan: subscriptionSummary.subscriptionPlan,
                    subscriptionLabel: subscriptionSummary.subscriptionLabel,
                    subscriptionStatus: subscriptionSummary.subscriptionStatus,
                    subscriptionExpiresAt: subscriptionSummary.subscriptionExpiresAt,
                    subscriptionFeatures: subscriptionSummary.subscriptionFeatures,
                    subscriptionFeatureFlags: subscriptionSummary.subscriptionFeatureFlags,
                    subscriptionLimits: subscriptionSummary.subscriptionLimits
                };

                if (user.role && typeof user.role === 'object' && user.role.name) {
                    let permissions = await getEffectivePermissionsForRole(user.role);
                    if (isSuperAdmin) {
                        permissions = [
                            {
                                module: 'subscription',
                                actions: ['create', 'read', 'update', 'delete']
                            }
                        ];
                    }
                    userData.role = {
                        id: user.role._id,
                        name: user.role.name,
                        priority: user.role.priority,
                        permissions,
                        isSystemRole: user.role.isSystemRole || false,
                        description: user.role.description || null
                    };
                    userData.assigneePermissions = getAssigneePermissionsForRole(user.role);
                } else {
                    userData.assigneePermissions = { canAssignClient: false, canAssignCase: false };
                }
            }

            return res.status(403).json({
                success: false,
                error: subscriptionCheck.reason,
                token: expiredToken,
                canManageSubscription: true,
                user: userData
            });
        }

        return next(new ErrorResponse(subscriptionCheck.reason, 403));
    }

    // 7. Create token with appropriate role
    // For admin users, include role ID in token if available
    let roleId = userType;
    if (userType === 'admin' && user.role) {
        // Get role ID whether it's populated or not
        if (typeof user.role === 'object' && user.role._id) {
            roleId = user.role._id;
        } else if (typeof user.role === 'string') {
            roleId = user.role;
        } else if (Buffer.isBuffer(user.role)) {
            roleId = user.role.toString('hex');
        }
    }
    
    const tokenPayload = {
        id: user._id,
        email: user.email,
        organization: user.organization?._id || user.organization,
        role: roleId
    };
    
    const token = jwt.sign(
        tokenPayload,
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
    );

    const subscriptionSummary = getSubscriptionSummary(user.organization);

    console.log('✅ Login successful for:', userType, user.email);

    // 8. Send response with token and user data
    if (userType === 'employee') {
        res.status(200).json({
            success: true,
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                address: user.address,
                gender: user.gender,
                dateOfBirth: user.dateOfBirth,
                age: user.age,
                aadharCardNumber: user.aadharCardNumber,
                employeeType: user.employeeType,
                advocateLicenseNumber: user.advocateLicenseNumber,
                internYear: user.internYear,
                salary: user.salary,
                department: user.department,
                position: user.position,
                startDate: user.startDate,
                emergencyContactName: user.emergencyContactName,
                emergencyContactPhone: user.emergencyContactPhone,
                emergencyContactRelation: user.emergencyContactRelation,
                organization: user.organization,
                adminId: user.adminId,
                status: user.status,
                role: 'employee',
                subscriptionPlan: subscriptionSummary.subscriptionPlan,
                subscriptionLabel: subscriptionSummary.subscriptionLabel,
                subscriptionStatus: subscriptionSummary.subscriptionStatus,
                subscriptionExpiresAt: subscriptionSummary.subscriptionExpiresAt,
                subscriptionFeatures: subscriptionSummary.subscriptionFeatures,
                subscriptionFeatureFlags: subscriptionSummary.subscriptionFeatureFlags,
                subscriptionLimits: subscriptionSummary.subscriptionLimits,
                createdAt: user.createdAt
            }
        });
    } else {
        // Ensure role is populated if it wasn't already
        if (user.role && (!user.role.name || typeof user.role === 'string' || Buffer.isBuffer(user.role))) {
            const Role = require('../models/Role');
            let roleId = user.role;
            
            // Convert Buffer to string if needed
            if (Buffer.isBuffer(roleId)) {
                roleId = roleId.toString('hex');
            } else if (typeof roleId === 'object' && roleId.toString) {
                roleId = roleId.toString();
            }
            
            if (roleId) {
                const role = await Role.findById(roleId);
                if (role) {
                    user.role = role;
                }
            }
        }
        
        // Format response to match setup response exactly
        const responseData = {
            success: true,
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                organizationId: user.organization?._id || user.organization || null,
                subscriptionPlan: subscriptionSummary.subscriptionPlan,
                subscriptionLabel: subscriptionSummary.subscriptionLabel,
                subscriptionStatus: subscriptionSummary.subscriptionStatus,
                subscriptionExpiresAt: subscriptionSummary.subscriptionExpiresAt,
                subscriptionFeatures: subscriptionSummary.subscriptionFeatures,
                subscriptionFeatureFlags: subscriptionSummary.subscriptionFeatureFlags,
                subscriptionLimits: subscriptionSummary.subscriptionLimits
            }
        };

        if (user.role && typeof user.role === 'object' && user.role.name) {
            responseData.user.role = {
                id: user.role._id,
                name: user.role.name,
                priority: user.role.priority,
                permissions,
                isSystemRole: user.role.isSystemRole || false,
                description: user.role.description || null
            };
            // Frontend: show assignee dropdown only when true (only these users can assign client/case to others)
            responseData.user.assigneePermissions = getAssigneePermissionsForRole(user.role);
        } else {
            responseData.user.assigneePermissions = { canAssignClient: false, canAssignCase: false };
        }

        res.status(200).json(responseData);
    }
});

// @desc      Forgot password (send reset email)
// @route     POST /api/auth/forgot-password
// @access    Public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
    const { email } = req.body;

    if (!email) {
        return next(new ErrorResponse('Email is required', 400));
    }

    const normalizedEmail = email.toLowerCase().trim();

    let accountType = 'user';
    let account = await User.findOne({ email: normalizedEmail }).select('+resetPasswordToken +resetPasswordExpire');

    if (!account) {
        account = await Employee.findOne({ email: normalizedEmail }).select('+resetPasswordToken +resetPasswordExpire');
        accountType = 'employee';
    }

    if (!account) {
        return next(new ErrorResponse('No account found with this email', 404));
    }

    const resetToken = account.getResetPasswordToken();
    await account.save({ validateBeforeSave: false });

    const appUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000';
    const resetLink = `${appUrl.replace(/\/$/, '')}/reset-password?token=${resetToken}`;

    const fullName = `${account.firstName || ''} ${account.lastName || ''}`.trim();
    const organizationName = accountType === 'user'
        ? 'CaseSnap'
        : (account.organization?.companyName || 'CaseSnap');

    const emailResult = await sendPasswordResetEmail({
        to: account.email,
        fullName: fullName || 'User',
        resetLink,
        organizationName
    });

    if (!emailResult.success) {
        account.resetPasswordToken = undefined;
        account.resetPasswordExpire = undefined;
        await account.save({ validateBeforeSave: false });
        return next(new ErrorResponse(emailResult.message || 'Failed to send reset email', 500));
    }

    res.status(200).json({
        success: true,
        message: 'Password reset link sent to your email',
        data: {
            email: account.email
        }
    });
});

// @desc      Reset password via token
// @route     PUT /api/auth/reset-password/:resetToken
// @access    Public
exports.resetPassword = asyncHandler(async (req, res, next) => {
    const { resetToken } = req.params;
    const { password, confirmPassword } = req.body;

    if (!password) {
        return next(new ErrorResponse('New password is required', 400));
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
        return next(new ErrorResponse('Password and confirm password do not match', 400));
    }

    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    let account = await User.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpire: { $gt: Date.now() }
    }).select('+password +resetPasswordToken +resetPasswordExpire');

    if (!account) {
        account = await Employee.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() }
        }).select('+password +resetPasswordToken +resetPasswordExpire');
    }

    if (!account) {
        return next(new ErrorResponse('Reset token is invalid or expired', 400));
    }

    account.password = password;
    account.resetPasswordToken = undefined;
    account.resetPasswordExpire = undefined;
    await account.save();

    res.status(200).json({
        success: true,
        message: 'Password reset successful. Please login with your new password.'
    });
});

// @desc      Change password for logged-in user
// @route     PUT /api/auth/change-password
// @access    Private
exports.changePassword = asyncHandler(async (req, res, next) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return next(new ErrorResponse('Current password and new password are required', 400));
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
        return next(new ErrorResponse('New password and confirm password do not match', 400));
    }

    const isEmployee = req.userType === 'employee';
    const AccountModel = isEmployee ? Employee : User;

    const account = await AccountModel.findById(req.user._id).select('+password');
    if (!account) {
        return next(new ErrorResponse('User not found', 404));
    }

    const isMatch = await account.matchPassword(currentPassword);
    if (!isMatch) {
        return next(new ErrorResponse('Current password is incorrect', 400));
    }

    account.password = newPassword;
    await account.save();

    res.status(200).json({
        success: true,
        message: 'Password changed successfully'
    });
});

// @desc      Logout user
// @route     POST /api/auth/logout
// @access    Private (requires authentication)
exports.logout = asyncHandler(async (req, res, next) => {
    // Since JWT tokens are stateless, logout is primarily handled client-side
    // This endpoint confirms logout and can be used for logging/logging out events
    
    console.log('🚪 Logout request from user:', req.user?.email || req.user?._id);
    
    res.status(200).json({
        success: true,
        message: 'Logged out successfully'
    });
});

// @desc      Register Initial Admin User
// @route     POST /api/auth/register-admin
// @access    Public (only for initial setup)
exports.registerInitialAdmin = asyncHandler(async (req, res, next) => {
    const { username, email, password } = req.body;

    // 1. Check if an admin user already exists
    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) {
        return next(new ErrorResponse('An admin user already exists. Initial setup already completed.', 400));
    }

    // 2. Create the new user with an 'admin' role
    const user = await User.create({
        username,
        email,
        password,
        role: 'admin' // Force role to admin for the setup process
    });

    // 3. Send response
    // For now, we'll just send success message. Later we'll send a token.
    res.status(201).json({
        success: true,
        message: 'Initial admin user registered successfully.'
        // user: { // Optionally, you can send back non-sensitive user data
        //     id: user._id,
        //     username: user.username,
        //     email: user.email,
        //     role: user.role
        // }
    });
});