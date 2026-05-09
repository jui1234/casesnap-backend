// controllers/userController.js

const User = require('../models/User');
const Role = require('../models/Role');
const Organization = require('../models/Organization');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const crypto = require('crypto');
const { sendUserInvitation } = require('../utils/gmailService');
const { roleHasAssigneePermission, checkAssigneeLimit, getAssigneePermissionsForRole } = require('../utils/assigneeUtils');

// @desc      Send user invitation
// @route     POST /api/users/invite
// @access    Private (Admin with user create permission)
exports.sendUserInvitation = asyncHandler(async (req, res, next) => {
    const { firstName, lastName, email, phone, roleId, userType, salary } = req.body;
    const organizationId = req.user.organization; // From JWT token

    console.log('📧 Sending user invitation...');
    console.log('👤 User data:', { firstName, lastName, email, phone, roleId, userType, salary });
    console.log('🏢 Organization ID:', organizationId);

    // Validate required fields
    if (!email) {
        return next(new ErrorResponse('Email is required', 400));
    }

    if (!firstName || !lastName) {
        return next(new ErrorResponse('First name and last name are required', 400));
    }

    if (!phone) {
        return next(new ErrorResponse('Phone number is required', 400));
    }

    if (!roleId) {
        return next(new ErrorResponse('Role ID is required', 400));
    }

    // Validate userType if provided
    if (userType && !['advocate', 'intern', 'non'].includes(userType)) {
        return next(new ErrorResponse('userType must be one of: advocate, intern, non', 400));
    }

    // Validate salary if provided
    if (salary !== undefined && salary !== null && salary !== '') {
        if (isNaN(salary) || salary < 0) {
            return next(new ErrorResponse('Salary must be a valid positive number', 400));
        }
    }

    // Validate phone format
    if (!/^\d{10}$/.test(phone)) {
        return next(new ErrorResponse('Phone number must be a 10-digit number', 400));
    }

    // Validate role exists and belongs to organization
    const role = await Role.findOne({
        _id: roleId,
        organization: organizationId
    });

    if (!role) {
        return next(new ErrorResponse('Role not found or does not belong to your organization', 404));
    }

    // Check if trying to invite SUPER_ADMIN
    const isSuperAdminRole = role.priority === 1 && role.isSystemRole === true;
    
    if (isSuperAdminRole) {
        // Check if SUPER_ADMIN already exists in organization
        const existingSuperAdmin = await User.findOne({
            organization: organizationId,
            role: roleId,
            status: { $ne: 'terminated' } // Don't count terminated users
        }).populate('role');

        if (existingSuperAdmin) {
            return next(new ErrorResponse('SUPER_ADMIN already exists in this organization. Only one SUPER_ADMIN is allowed per organization.', 400));
        }
    }

    // Enforce assignee limit for ALL admins including SUPER_ADMIN (invited user will become assignee)
    if (roleHasAssigneePermission(role)) {
        const { allowed, current, limit } = await checkAssigneeLimit(organizationId, false);
        if (!allowed) {
            return next(new ErrorResponse(
                `Assignee limit reached for your plan (${limit} assignee(s)). Current assignees: ${current}. Upgrade plan to invite more users with assignee permission.`,
                400
            ));
        }
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
        email: email.toLowerCase(),
        organization: organizationId 
    });

    console.log('🔍 Existing user check:', existingUser ? {
        id: existingUser._id,
        email: existingUser.email,
        invitationStatus: existingUser.invitationStatus,
        role: existingUser.role
    } : 'No existing user found');

    if (existingUser) {
        if (existingUser.invitationStatus === 'completed') {
            return next(new ErrorResponse('A user with this email already exists in your organization', 400));
        } else if (existingUser.invitationStatus === 'pending') {
            return next(new ErrorResponse('An invitation has already been sent to this email address', 400));
        } else if (existingUser.invitationStatus === 'expired') {
            // Allow re-inviting expired invitations
            console.log('🔄 Re-inviting expired user invitation');
        } else {
            // Handle any other status - treat as existing user
            console.log('🔄 Re-inviting user with status:', existingUser.invitationStatus);
        }
    }

    // Generate unique invitation token
    const invitationToken = crypto.randomBytes(32).toString('hex');
    
    // Get organization details
    const organization = await Organization.findById(organizationId);
    if (!organization) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    // Create or update user record
    let user;
    try {
        if (existingUser) {
            // Update existing user - only update invitation-related fields
            // Check if role is SUPER_ADMIN
            const isSuperAdminRole = role.priority === 1 && role.isSystemRole === true;
            
            // If updating to SUPER_ADMIN, check if one already exists
            if (isSuperAdminRole) {
                const existingSuperAdmin = await User.findOne({
                    organization: organizationId,
                    role: roleId,
                    _id: { $ne: existingUser._id }, // Exclude current user
                    status: { $ne: 'terminated' }
                }).populate('role');

                if (existingSuperAdmin) {
                    return next(new ErrorResponse('SUPER_ADMIN already exists in this organization. Only one SUPER_ADMIN is allowed per organization.', 400));
                }
            }
            
            // SUPER_ADMIN is auto-approved, others are pending
            const initialStatus = isSuperAdminRole ? 'approved' : 'pending';
            
            const updateFields = {
                firstName,
                lastName,
                email: email.toLowerCase(),
                phone,
                role: roleId,
                userType: userType || 'non', // Default to 'non' if not provided
                salary: salary || 0, // Default to 0 if not provided
                status: initialStatus, // SUPER_ADMIN is auto-approved, others are pending
                invitedBy: req.user._id, // Store who sent the invitation
                invitationToken,
                invitationExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                invitationStatus: 'pending'
            };
            
            user = await User.findByIdAndUpdate(
                existingUser._id,
                updateFields,
                { new: true, runValidators: false }
            );
            console.log('✅ Updated existing user invitation');
        } else {
            // Create new user record
            // Password will be set during registration, not required now
            // Check if role is SUPER_ADMIN for auto-approval
            const isSuperAdminRole = role.priority === 1 && role.isSystemRole === true;
            const initialStatus = isSuperAdminRole ? 'approved' : 'pending';
            
            user = await User.create({
                username: email.toLowerCase(), // Use email as username
                firstName,
                lastName,
                email: email.toLowerCase(),
                phone,
                // password: not set during invitation, will be set during registration
                role: roleId,
                organization: organizationId,
                userType: userType || 'non', // Default to 'non' if not provided
                salary: salary || 0, // Default to 0 if not provided
                status: initialStatus, // SUPER_ADMIN is auto-approved, others are pending
                invitedBy: req.user._id, // Store who sent the invitation
                invitationToken,
                invitationStatus: 'pending',
                invitationExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
            });
            
            if (isSuperAdminRole) {
                console.log('✅ Created new SUPER_ADMIN user invitation (auto-approved)');
            } else {
                console.log('✅ Created new user invitation');
            }
        }
    } catch (error) {
        console.error('❌ Error creating/updating user:', error.message);
        
        // Handle duplicate key errors
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return next(new ErrorResponse(`A user with this ${field} already exists. Please use a different ${field}.`, 400));
        }
        
        // Generic error
        return next(new ErrorResponse('Failed to create user invitation. Please try again.', 500));
    }

    // Generate invitation link with all parameters including roleName, userType, and salary
    const userTypeValue = userType || 'non';
    const salaryValue = salary !== undefined && salary !== null ? salary : 0;
    let invitationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/users/register?token=${invitationToken}&userName=${encodeURIComponent(firstName + ' ' + lastName)}&organizationName=${encodeURIComponent(organization.companyName)}&adminName=${encodeURIComponent(req.user.firstName + ' ' + req.user.lastName)}&adminId=${req.user._id}&userEmail=${encodeURIComponent(email)}&roleId=${roleId}&roleName=${encodeURIComponent(role.name)}&userType=${encodeURIComponent(userTypeValue)}&salary=${salaryValue}`;
    
    console.log('💰 Salary value in invitation link:', salaryValue);
    
    console.log('🔗 Invitation link generated:', invitationLink);
    console.log('🔑 Invitation token:', invitationToken);
    console.log('📧 User email:', email);

    // Send email with invitation link using Gmail SMTP
    const emailResult = await sendUserInvitation({
        to: email,
        firstName,
        lastName,
        organizationName: organization.companyName,
        companyEmail: organization.companyEmail,
        adminName: `${req.user.firstName} ${req.user.lastName}`,
        roleName: role.name,
        invitationLink
    });

    // Check email sending result
    if (!emailResult.success) {
        console.error('❌ Email sending failed:', emailResult.error);
        // Still return success but log the email error
        // The invitation link is still valid and can be shared manually
    }

    res.status(201).json({
        success: true,
        message: 'User invitation sent successfully',
        data: {
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                role: {
                    id: role._id,
                    name: role.name,
                    priority: role.priority
                },
                userType: user.userType || 'non',
                salary: user.salary || 0,
                invitationStatus: user.invitationStatus,
                invitationExpires: user.invitationExpires
            },
            invitationLink: invitationLink, // Include link in response for manual sharing if needed
            emailSent: emailResult.success
        }
    });
});

// @desc      Get user by invitation token
// @route     GET /api/users/register/:token
// @access    Public (but authorization check if authenticated)
exports.getUserByToken = asyncHandler(async (req, res, next) => {
    const { token } = req.params;

    console.log('🔍 Looking up user by invitation token:', token);

    // Find user by invitation token
    let user = await User.findOne({ 
        invitationToken: token,
        invitationStatus: 'pending'
    }).populate('organization', 'companyName companyEmail')
      .populate('role', 'name priority')
      .populate('invitedBy', 'firstName lastName email');

    if (!user) {
        console.log('❌ No user found with token:', token);
        return next(new ErrorResponse('Invalid or expired invitation link', 400));
    }

    // Check if invitation has expired
    if (user.invitationExpires && user.invitationExpires < new Date()) {
        user.invitationStatus = 'expired';
        await user.save();
        return next(new ErrorResponse('Invitation link has expired', 400));
    }

    // If user is authenticated, check authorization
    if (req.user) {
        const currentUser = await User.findById(req.user._id).populate('role');
        if (currentUser && currentUser.role) {
            // Check if current user is the inviter
            const isInviter = user.invitedBy && user.invitedBy.toString() === currentUser._id.toString();
            
            // Check if current user's role can manage the invited user's role
            let canManage = false;
            if (user.role && currentUser.role) {
                // Can manage if current user's priority is lower (higher authority)
                canManage = currentUser.role.priority < user.role.priority;
            }

            if (!isInviter && !canManage) {
                return next(new ErrorResponse('You do not have permission to view this invitation', 403));
            }
        }
    }

    console.log('✅ User found:', {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        organization: user.organization?.companyName || 'N/A',
        role: user.role?.name || 'N/A'
    });

    res.status(200).json({
        success: true,
        data: {
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                role: user.role ? {
                    id: user.role._id,
                    name: user.role.name,
                    priority: user.role.priority
                } : null,
                userType: user.userType || 'non',
                salary: user.salary || 0,
                organization: user.organization
            }
        }
    });
});

// @desc      Complete user registration
// @route     POST /api/users/register/:token
// @access    Public (but authorization check if authenticated)
exports.completeUserRegistration = asyncHandler(async (req, res, next) => {
    const { token } = req.params;
    const { password, confirmPassword } = req.body;

    console.log('📝 Completing user registration...');
    console.log('🔑 Token:', token);

    // Validate password
    if (!password || !confirmPassword) {
        return next(new ErrorResponse('Password and confirm password are required', 400));
    }

    if (password !== confirmPassword) {
        return next(new ErrorResponse('Password and confirm password do not match', 400));
    }

    if (password.length < 6) {
        return next(new ErrorResponse('Password must be at least 6 characters long', 400));
    }

    // Find user by token
    const user = await User.findOne({ 
        invitationToken: token,
        invitationStatus: 'pending'
    }).populate('role')
      .populate('invitedBy');

    if (!user) {
        return next(new ErrorResponse('Invalid or expired invitation link', 400));
    }

    // Check if invitation has expired
    if (user.invitationExpires && user.invitationExpires < new Date()) {
        user.invitationStatus = 'expired';
        await user.save();
        return next(new ErrorResponse('Invitation link has expired', 400));
    }

    // Authorization check: If user is authenticated, verify they can complete this registration
    // Only the inviter or someone with higher role priority can complete registration
    if (req.user && req.userType === 'admin') {
        const currentUser = await User.findById(req.user._id).populate('role');
        if (currentUser && currentUser.role) {
            // Check if current user is the inviter
            const isInviter = user.invitedBy && user.invitedBy.toString() === currentUser._id.toString();
            
            // Check if current user's role can manage the invited user's role
            let canManage = false;
            if (user.role && currentUser.role) {
                // Can manage if current user's priority is lower (higher authority)
                // Lower priority number = higher authority
                canManage = currentUser.role.priority < user.role.priority;
            }

            if (!isInviter && !canManage) {
                return next(new ErrorResponse('You do not have permission to complete this registration. Only the person who sent the invite or someone with higher role priority can complete it.', 403));
            }
        }
    }

    // Update user with password and complete registration
    user.password = password;
    user.invitationStatus = 'completed';
    user.invitationToken = undefined; // Remove token after completion
    
    // Check if user is SUPER_ADMIN - auto-approve, others stay pending
    const userRole = await Role.findById(user.role);
    const isSuperAdmin = userRole && userRole.priority === 1 && userRole.isSystemRole === true;
    
    if (isSuperAdmin) {
        user.status = 'approved'; // SUPER_ADMIN is auto-approved
        console.log('✅ SUPER_ADMIN registration completed and auto-approved');
    } else {
        user.status = 'pending'; // Keep status as 'pending' - admin needs to approve before user can login
    }

    await user.save();
    
    // Only send notifications for non-SUPER_ADMIN users
    if (!isSuperAdmin && userRole) {
        // Notify admins/roles that user has completed registration
        // Find users with role that can manage this user's role (for notifications)
        // Find all users with roles that have lower priority (higher authority) than this user's role
        const adminRoles = await Role.find({
            organization: user.organization,
            priority: { $lt: userRole.priority }
        }).select('_id');

        const adminUserIds = adminRoles.map(r => r._id);
        
        // Also include the inviter
        if (user.invitedBy) {
            adminUserIds.push(user.invitedBy);
        }

        console.log('📢 User registration completed. Notifying admins with IDs:', adminUserIds);
        console.log('📢 User details:', {
            id: user._id,
            name: `${user.firstName} ${user.lastName}`,
            email: user.email,
            role: userRole.name,
            status: 'pending - awaiting approval'
        });
        // In a real application, you would send notifications/emails here
        // For now, we'll just log it. You can integrate with a notification service later.
    } else if (isSuperAdmin) {
        console.log('✅ SUPER_ADMIN registration completed and auto-approved - no notification needed');
    }

    console.log('✅ User registration completed:', {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        status: isSuperAdmin ? 'approved - can login immediately' : 'pending - awaiting admin approval'
    });

    res.status(200).json({
        success: true,
        message: 'User registration completed successfully',
        data: {
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                role: user.role ? {
                    id: user.role._id,
                    name: user.role.name,
                    priority: user.role.priority
                } : null,
                userType: user.userType || 'non',
                salary: user.salary || 0,
                status: user.status,
                invitationStatus: user.invitationStatus
            }
        }
    });
});

// Helper function to check if user can access another user
// SUPER_ADMIN can access all users, others can only access users they created
const canAccessUser = (currentUser, targetUser) => {
    // Check if current user is SUPER_ADMIN
    if (currentUser.role && typeof currentUser.role === 'object') {
        const isSuperAdmin = currentUser.role.priority === 1 && currentUser.role.isSystemRole === true;
        if (isSuperAdmin) {
            return true; // SUPER_ADMIN can access all users
        }
    }
    
    // Other users can only access users they created
    // Handle both string ID and populated object
    let invitedById = targetUser.invitedBy;
    if (invitedById && typeof invitedById === 'object' && invitedById._id) {
        invitedById = invitedById._id;
    }
    
    if (invitedById && invitedById.toString() === currentUser._id.toString()) {
        return true;
    }
    
    return false;
};

// @desc      Get list of users for assignee dropdown (client/case assignment)
// @route     GET /api/users/assignable
// @access    Private (only users with assignee permission: canAssignClient or canAssignCase)
//            Returns all org users (no priority filter) so assignee can assign to anyone including upper priority
exports.getAssignableUsers = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const { search, limit = 100 } = req.query;

    const query = {
        organization: organizationId,
        status: 'approved'
    };

    if (search && search.trim()) {
        const s = search.trim();
        query.$or = [
            { firstName: { $regex: s, $options: 'i' } },
            { lastName: { $regex: s, $options: 'i' } },
            { email: { $regex: s, $options: 'i' } }
        ];
    }

    const limitNum = Math.min(parseInt(limit, 10) || 100, 200);
    const users = await User.find(query)
        .select('_id firstName lastName email role')
        .populate('role', '_id name')
        .sort({ firstName: 1, lastName: 1 })
        .limit(limitNum)
        .lean();

    const data = users.map((u) => ({
        id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role ? { id: u.role._id, name: u.role.name } : null
    }));

    res.status(200).json({
        success: true,
        count: data.length,
        data
    });
});

// @desc      Get all users for organization (with filtering and pagination)
// @route     GET /api/users
// @access    Private (Admin with user read permission)
exports.getUsers = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const { status, roleId, search, page = 1, limit = 10 } = req.query;

    // Check if current user is SUPER_ADMIN
    const currentUser = await User.findById(req.user._id).populate('role', 'priority isSystemRole');
    const isSuperAdmin = currentUser.role && 
                        currentUser.role.priority === 1 && 
                        currentUser.role.isSystemRole === true;

    // Build query
    const query = { organization: organizationId };
    
    // Exclude the currently logged-in user
    query._id = { $ne: req.user._id };
    
    // If not SUPER_ADMIN, apply hierarchical visibility rules
    if (!isSuperAdmin && currentUser.role) {
        const currentUserPriority = currentUser.role.priority;
        
        // Get all users in the organization with their roles and inviters
        // We'll filter them based on hierarchical rules
        const allUsers = await User.find({ organization: organizationId })
            .select('_id role invitedBy')
            .populate('role', 'priority')
            .lean(); // Use lean() for better performance
        
        // Get inviter roles for all users
        const inviterIds = [...new Set(allUsers
            .filter(u => u.invitedBy)
            .map(u => u.invitedBy.toString()))];
        
        const inviters = await User.find({ _id: { $in: inviterIds } })
            .select('_id role')
            .populate('role', 'priority')
            .lean();
        
        const inviterMap = new Map();
        inviters.forEach(inviter => {
            inviterMap.set(inviter._id.toString(), inviter.role ? inviter.role.priority : null);
        });
        
        // Filter users that current user can see:
        // 1. Users they created (invitedBy = currentUser._id)
        // 2. Users with lower priority (higher priority number) that were created by someone with equal or higher priority (lower priority number)
        const visibleUserIds = allUsers
            .filter(u => {
                // Exclude current user
                if (u._id.toString() === req.user._id.toString()) {
                    return false;
                }
                
                const userRolePriority = u.role ? u.role.priority : null;
                const inviterId = u.invitedBy ? u.invitedBy.toString() : null;
                const inviterRolePriority = inviterId ? inviterMap.get(inviterId) : null;
                
                // User created by current user
                if (inviterId === req.user._id.toString()) {
                    return true;
                }
                
                // User with lower priority (higher priority number) created by someone with higher priority (lower priority number)
                // Note: Users with same priority cannot see each other's invited users
                if (userRolePriority && inviterRolePriority) {
                    const userIsLowerPriority = userRolePriority > currentUserPriority;
                    const inviterIsHigherPriority = inviterRolePriority < currentUserPriority; // Must be strictly higher, not equal
                    return userIsLowerPriority && inviterIsHigherPriority;
                }
                
                return false;
            })
            .map(u => u._id);
        
        // If no visible users, return empty result
        if (visibleUserIds.length === 0) {
            query._id = { $in: [] }; // No users match
        } else {
            // Remove the $ne filter and use $in with exclusion
            delete query._id;
            query._id = { 
                $in: visibleUserIds.filter(id => id.toString() !== req.user._id.toString())
            };
        }
    }

    // Filter by status
    if (status && status !== 'all') {
        if (Array.isArray(status)) {
            query.status = { $in: status };
        } else if (status.includes(',')) {
            // Handle comma-separated statuses
            const statuses = status.split(',').map(s => s.trim());
            query.status = { $in: statuses };
        } else {
            query.status = status;
        }
    }

    // Filter by role
    if (roleId && roleId !== 'all') {
        query.role = roleId;
    }

    // Search by name or email
    if (search) {
        query.$or = [
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Execute query
    const users = await User.find(query)
        .select('-invitationToken -password')
        .populate('role', 'name priority permissions isSystemRole')
        .populate('invitedBy', 'firstName lastName email')
        .populate('organization', 'companyName companyEmail')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum);

    const total = await User.countDocuments(query);

    res.status(200).json({
        success: true,
        count: users.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        data: users
    });
});

// @desc      Get single user by ID
// @route     GET /api/users/:id
// @access    Private (Admin with user read permission)
exports.getUser = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    const user = await User.findOne({
        _id: id,
        organization: organizationId
    })
        .select('-invitationToken -password')
        .populate('role', 'name priority permissions isSystemRole description')
        .populate('invitedBy', 'firstName lastName email')
        .populate('organization', 'companyName companyEmail subscriptionPlan');

    if (!user) {
        return next(new ErrorResponse('User not found', 404));
    }

    // Check if current user can access this user
    const currentUser = await User.findById(req.user._id).populate('role', 'priority isSystemRole');
    const hasAccess = canAccessUser(currentUser, user);
    
    if (!hasAccess) {
        return next(new ErrorResponse('You do not have permission to access this user. You can only access users you created.', 403));
    }

    res.status(200).json({
        success: true,
        data: user
    });
});

// @desc      Update user
// @route     PUT /api/users/:id
// @access    Private (Admin with user update permission)
exports.updateUser = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const { firstName, lastName, email, phone, roleId, userType, salary, status } = req.body;

    const user = await User.findOne({
        _id: id,
        organization: organizationId
    })
        .populate('role', 'priority isSystemRole')
        .populate('invitedBy');

    if (!user) {
        return next(new ErrorResponse('User not found', 404));
    }

    // Check if current user can access this user
    const currentUser = await User.findById(req.user._id).populate('role', 'priority isSystemRole');
    const hasAccess = canAccessUser(currentUser, user);
    
    if (!hasAccess) {
        return next(new ErrorResponse('You do not have permission to update this user. You can only update users you created.', 403));
    }

    // Update fields
    if (firstName !== undefined) user.firstName = firstName;
    if (lastName !== undefined) user.lastName = lastName;
    if (email !== undefined) user.email = email.toLowerCase();
    if (phone !== undefined) user.phone = phone;
    if (userType !== undefined) user.userType = userType;
    if (salary !== undefined) user.salary = salary;
    if (roleId !== undefined) {
        // Validate role exists and belongs to organization
        const role = await Role.findOne({
            _id: roleId,
            organization: organizationId
        });
        if (!role) {
            return next(new ErrorResponse('Role not found or does not belong to your organization', 404));
        }
        // Enforce assignee limit for ALL admins including SUPER_ADMIN (plan limit applies to organization)
        if (roleHasAssigneePermission(role)) {
            const currentRoleId = user.role ? (typeof user.role === 'object' && user.role._id ? user.role._id : user.role) : null;
            const wasAlreadyAssignee = currentRoleId
                ? roleHasAssigneePermission(await Role.findById(currentRoleId).select('permissions').lean())
                : false;
            const { allowed, current, limit } = await checkAssigneeLimit(organizationId, wasAlreadyAssignee);
            if (!allowed) {
                return next(new ErrorResponse(
                    `Assignee limit reached for your plan (${limit} assignee(s)). Current assignees: ${current}. Upgrade plan to add more assignees.`,
                    400
                ));
            }
        }
        user.role = roleId;
    }
    if (status !== undefined) {
        // Validate status
        if (!['pending', 'approved', 'inactive', 'terminated'].includes(status)) {
            return next(new ErrorResponse('Invalid status. Must be one of: pending, approved, inactive, terminated', 400));
        }
        
        // SUPER_ADMIN status must always be 'approved' (they are the owner of the organization)
        const userRole = await Role.findById(user.role);
        const isSuperAdmin = userRole && userRole.priority === 1 && userRole.isSystemRole === true;
        
        if (isSuperAdmin && status !== 'approved') {
            return next(new ErrorResponse('SUPER_ADMIN status must always be approved. Cannot change SUPER_ADMIN status.', 400));
        }
        
        user.status = status;
    }

    await user.save();

    // Populate before sending response
    await user.populate('role', 'name priority permissions isSystemRole');
    await user.populate('invitedBy', 'firstName lastName email');
    await user.populate('organization', 'companyName companyEmail');

    res.status(200).json({
        success: true,
        message: 'User updated successfully',
        data: user
    });
});

// @desc      Approve user (change status from pending to approved)
// @route     PUT /api/users/:id/approve
// @access    Private (Admin with user update permission)
exports.approveUser = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    const user = await User.findOne({
        _id: id,
        organization: organizationId
    })
        .populate('role', 'name priority')
        .populate('invitedBy', 'firstName lastName email');

    if (!user) {
        return next(new ErrorResponse('User not found', 404));
    }

    // Check if current user can access this user (hierarchical access)
    const currentUser = await User.findById(req.user._id).populate('role', 'priority isSystemRole');
    
    // Check if SUPER_ADMIN
    const isSuperAdmin = currentUser.role && 
                        currentUser.role.priority === 1 && 
                        currentUser.role.isSystemRole === true;
    
    let hasAccess = false;
    
    if (isSuperAdmin) {
        // SUPER_ADMIN can approve all users
        hasAccess = true;
    } else if (currentUser.role && user.role) {
        const currentUserPriority = currentUser.role.priority;
        const userRolePriority = user.role.priority;
        
        // Get inviter's role priority
        let inviterRolePriority = null;
        if (user.invitedBy) {
            const inviter = await User.findById(user.invitedBy).populate('role', 'priority');
            if (inviter && inviter.role) {
                inviterRolePriority = inviter.role.priority;
            }
        }
        
        // Can approve if:
        // 1. User was created by current user
        // 2. OR user has lower priority (higher priority number) AND inviter has equal or higher priority (lower priority number) than current user
        if (user.invitedBy && user.invitedBy.toString() === req.user._id.toString()) {
            hasAccess = true; // Created by current user
        } else if (userRolePriority && inviterRolePriority) {
            const userIsLowerPriority = userRolePriority > currentUserPriority;
            const inviterIsEqualOrHigher = inviterRolePriority <= currentUserPriority;
            hasAccess = userIsLowerPriority && inviterIsEqualOrHigher;
        }
    }
    
    if (!hasAccess) {
        return next(new ErrorResponse('You do not have permission to approve this user. You can only approve users you created or users with lower priority that were created by someone with equal or higher priority.', 403));
    }

    if (user.status !== 'pending') {
        return next(new ErrorResponse(`User status is ${user.status}, not pending. Only pending users can be approved.`, 400));
    }

    if (user.invitationStatus !== 'completed') {
        return next(new ErrorResponse('User has not completed registration yet', 400));
    }

    // Approve user
    user.status = 'approved';
    await user.save();

    // Populate before sending response
    await user.populate('role', 'name priority permissions isSystemRole');
    await user.populate('organization', 'companyName companyEmail');

    console.log('✅ User approved:', {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        approvedBy: currentUser.email
    });

    res.status(200).json({
        success: true,
        message: 'User approved successfully. User can now login.',
        data: user
    });
});

// @desc      Delete user (soft delete by setting status to terminated)
// @route     DELETE /api/users/:id
// @access    Private (Admin with user delete permission)
exports.deleteUser = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    const user = await User.findOne({
        _id: id,
        organization: organizationId
    })
        .populate('role', 'name priority')
        .populate('invitedBy');

    if (!user) {
        return next(new ErrorResponse('User not found', 404));
    }

    // Check if current user can access this user
    const currentUser = await User.findById(req.user._id).populate('role', 'priority isSystemRole');
    const hasAccess = canAccessUser(currentUser, user);
    
    if (!hasAccess) {
        return next(new ErrorResponse('You do not have permission to delete this user. You can only delete users you created.', 403));
    }

    // Prevent deleting SUPER_ADMIN
    if (user.role && user.role.priority === 1 && user.role.isSystemRole) {
        return next(new ErrorResponse('Cannot delete SUPER_ADMIN user', 403));
    }

    // Check if current user can delete (must have higher role priority)
    // Note: currentUser is already loaded above, but we need to ensure user.role is populated
    if (!user.role || typeof user.role === 'string') {
        await user.populate('role', 'priority isSystemRole');
    }
    
    if (currentUser && currentUser.role && user.role) {
        const canManage = currentUser.role.priority < user.role.priority;
        if (!canManage) {
            return next(new ErrorResponse('You do not have permission to delete this user. Only users with higher role priority can delete.', 403));
        }
    }

    // Soft delete by setting status to terminated
    user.status = 'terminated';
    await user.save();

    console.log('✅ User deleted (terminated):', {
        id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email
    });

    res.status(200).json({
        success: true,
        message: 'User deleted successfully',
        data: {
            id: user._id,
            status: user.status
        }
    });
});
