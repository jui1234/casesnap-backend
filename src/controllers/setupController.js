// controllers/setupController.js

const Organization = require('../models/Organization');
const User = require('../models/User');
const Role = require('../models/Role');
const Client = require('../models/Client');
const Case = require('../models/Case');
const Module = require('../models/Module');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const jwt = require('jsonwebtoken'); // For generating tokens
const { getAssigneePermissionsForRole } = require('../utils/assigneeUtils');
const { initializeDefaultModules } = require('../utils/initializeModules');
const { getEffectivePermissionsForRole } = require('../utils/roleUtils');
const { normalizePlanName } = require('../utils/subscriptionFeatureUtils');

function resolveOrganizationId(user) {
    if (!user || user.organization == null) return null;
    const org = user.organization;
    if (typeof org === 'object' && org !== null && org._id != null) {
        return String(org._id);
    }
    return String(org);
}

// @desc      Onboarding checklist for the current user's organization (counts + suggested next step)
// @route     GET /api/setup/onboarding-status
// @access    Private
exports.getOnboardingStatus = asyncHandler(async (req, res, next) => {
    const organizationId = resolveOrganizationId(req.user);
    if (!organizationId) {
        return next(new ErrorResponse('Organization not found for this user', 400));
    }

    const orgExists = await Organization.findById(organizationId).select('_id').lean();
    if (!orgExists) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    const [
        roleCount,
        customRoleCount,
        approvedUserCount,
        clientCount,
        caseCount
    ] = await Promise.all([
        Role.countDocuments({ organization: organizationId }),
        Role.countDocuments({ organization: organizationId, isSystemRole: false }),
        User.countDocuments({ organization: organizationId, status: 'approved' }),
        Client.countDocuments({ organization: organizationId, deletedAt: null }),
        Case.countDocuments({ organization: organizationId, deletedAt: null })
    ]);

    const readiness = {
        hasRoles: roleCount >= 1,
        hasCustomRoles: customRoleCount >= 1,
        hasApprovedUsers: approvedUserCount >= 1,
        hasClients: clientCount >= 1,
        hasCases: caseCount >= 1,
        suggestInviteMoreUsers: customRoleCount >= 1 && approvedUserCount <= 1
    };

    let suggestedNextStep = null;
    if (customRoleCount === 0) {
        suggestedNextStep = 'create_custom_role';
    } else if (clientCount === 0) {
        suggestedNextStep = 'create_client';
    } else if (caseCount === 0) {
        suggestedNextStep = 'create_case';
    }

    res.status(200).json({
        success: true,
        data: {
            organizationId,
            counts: {
                roles: roleCount,
                customRoles: customRoleCount,
                approvedUsers: approvedUserCount,
                clients: clientCount,
                cases: caseCount
            },
            readiness,
            suggestedNextStep
        }
    });
});

// @desc      Initialize Organization and Super Admin
// @route     POST /api/setup/initialize
// @access    Public (only for initial setup)
exports.initializeSetup = asyncHandler(async (req, res, next) => {
    const { organization: orgData, superAdmin: adminData } = req.body;
    
    console.log('🚀 Starting organization setup process...');
    console.log('📋 Organization data received:', {
        companyName: orgData?.companyName,
        companyEmail: orgData?.companyEmail,
        industry: orgData?.industry,
        subscriptionPlan: orgData?.subscriptionPlan
    });
    console.log('👤 Super Admin data received:', {
        firstName: adminData?.firstName,
        lastName: adminData?.lastName,
        email: adminData?.email
    });

    // -----------------------------------------------------------
    // 1. Initial Checks (Allow multiple organizations)
    // -----------------------------------------------------------
    // Check if the email is already used for a user
    console.log('🔍 Checking for existing user with email:', adminData.email);
    const existingUserWithEmail = await User.findOne({ 
        email: adminData.email
    });
    if (existingUserWithEmail) {
        console.log('❌ User with this email already exists');
        return next(new ErrorResponse('This email address is already registered. Please use a different email address.', 400));
    }
    console.log('✅ Email is available');

    // Check if organization name is already taken
    console.log('🔍 Checking for existing organization with name:', orgData.companyName);
    const existingOrgWithName = await Organization.findOne({ 
        companyName: orgData.companyName 
    });
    if (existingOrgWithName) {
        console.log('❌ Organization with this name already exists');
        return next(new ErrorResponse('An organization with this name already exists. Please choose a different company name.', 400));
    }
    console.log('✅ Organization name is available');

    // -----------------------------------------------------------
    // 2. Validate Frontend Data (basic backend validation, Mongoose will do more)
    // -----------------------------------------------------------
    if (!orgData || !adminData) {
        return next(new ErrorResponse('Organization and Super Admin data are required.', 400));
    }

    // You might want more specific checks here that mirror frontend validateOrganizationData
    // and validateSuperAdminData before Mongoose schema validation.
    if (adminData.password !== adminData.confirmPassword) {
        return next(new ErrorResponse('Password and confirm password do not match. Please make sure both passwords are identical.', 400));
    }
    
    // Validate subscription plan if provided
    if (orgData.subscriptionPlan) {
        const validPlans = ['free', 'basic_monthly', 'basic_yearly', 'professional_monthly', 'professional_yearly'];
        const normalizedPlan = normalizePlanName(orgData.subscriptionPlan);
        if (!validPlans.includes(normalizedPlan)) {
            return next(new ErrorResponse(`Invalid subscription plan. Must be one of: ${validPlans.join(', ')}`, 400));
        }
        orgData.subscriptionPlan = normalizedPlan;
    }
    // Note: Mongoose will handle the rest of the validation (required, unique, email format, etc.)

    // -----------------------------------------------------------
    // 3. Create Organization
    // -----------------------------------------------------------
    console.log('🏢 Creating organization...');
    let organization;
    try {
        organization = await Organization.create(orgData);
        console.log('✅ Organization created successfully:', {
            id: organization._id,
            name: organization.companyName,
            email: organization.companyEmail,
            subscriptionPlan: organization.subscriptionPlan
        });
    } catch (err) {
        console.error('❌ Error creating organization:', err);
        // Pass Mongoose validation errors
        return next(err); // This will be caught by our general error handler
    }

    // -----------------------------------------------------------
    // 4. Create Super Admin User and Link to Organization
    // -----------------------------------------------------------
    console.log('👤 Creating super admin user...');
    let superAdminUser;
    try {
        superAdminUser = await User.create({
            username: adminData.email, // Using email as username per frontend login
            firstName: adminData.firstName,
            lastName: adminData.lastName,
            email: adminData.email,
            phone: adminData.phone,
            password: adminData.password,
            organization: organization._id, // Link to the newly created organization
            status: 'approved' // SUPER_ADMIN is always approved as they are the owner of the organization
            // Note: role (ObjectId) will be assigned after SUPER_ADMIN role is created
        });
        console.log('✅ Super admin user created successfully:', {
            id: superAdminUser._id,
            name: `${superAdminUser.firstName} ${superAdminUser.lastName}`,
            email: superAdminUser.email,
            role: superAdminUser.role,
            organizationId: superAdminUser.organization
        });
    } catch (err) {
        // If user creation fails, we should ideally roll back the organization creation
        // For simplicity now, we're just letting it fail. A transaction would be better here.
        console.error('❌ Error creating super admin user:', err);
        console.log('🧹 Cleaning up organization due to user creation failure...');
        // If org creation succeeded but user failed, delete the org to allow retry
        await Organization.findByIdAndDelete(organization._id);
        console.log('✅ Organization cleaned up');
        return next(err);
    }

    // -----------------------------------------------------------
    // 5. Create SUPER_ADMIN Role (Priority 1)
    // -----------------------------------------------------------
    console.log('👑 Creating SUPER_ADMIN role...');
    
    // Ensure default modules exist (handles case when MongoDB was dropped/cleared
    // while server was running - initializeDefaultModules only runs on first DB connect)
    await initializeDefaultModules();
    
    // Get all active modules dynamically from database
    let activeModules = await Module.find({ isActive: true }).select('name');
    console.log('📦 Active modules found:', activeModules.map(m => m.name));
    
    // Fallback: if no modules exist (e.g. DB was freshly dropped), use default module names
    const DEFAULT_MODULE_NAMES = ['client', 'cases', 'role', 'user'];
    if (activeModules.length === 0) {
        console.log('⚠️ No modules in DB, using default module names for SUPER_ADMIN permissions');
        activeModules = DEFAULT_MODULE_NAMES.map(name => ({ name }));
    }
    
    // Build permissions dynamically based on available modules
    const permissions = activeModules.map(module => ({
        module: module.name,
        actions: ['create', 'read', 'update', 'delete']
    }));
    
    console.log('🔐 SUPER_ADMIN permissions:', permissions);
    
    let superAdminRole;
    try {
        superAdminRole = await Role.create({
            name: 'SUPER_ADMIN',
            description: 'Super Administrator with full system access',
            organization: organization._id,
            priority: 1, // Highest priority
            isSystemRole: true,
            permissions: permissions, // Dynamic permissions based on available modules
            createdBy: superAdminUser._id
        });
        console.log('✅ SUPER_ADMIN role created successfully');
    } catch (err) {
        console.error('❌ Error creating SUPER_ADMIN role:', err);
        console.log('🧹 Cleaning up due to role creation failure...');
        await User.findByIdAndDelete(superAdminUser._id);
        await Organization.findByIdAndDelete(organization._id);
        return next(err);
    }

    // -----------------------------------------------------------
    // 6. Assign SUPER_ADMIN Role to Super Admin User
    // -----------------------------------------------------------
    console.log('🔗 Assigning SUPER_ADMIN role to super admin user...');
    superAdminUser.role = superAdminRole._id;
    await superAdminUser.save();
    console.log('✅ SUPER_ADMIN role assigned to user');

    // -----------------------------------------------------------
    // 7. Update Organization with Super Admin reference
    // -----------------------------------------------------------
    console.log('🔗 Linking super admin to organization...');
    organization.superAdmin = superAdminUser._id;
    await organization.save(); // Save the updated organization
    console.log('✅ Organization updated with super admin reference');

    // -----------------------------------------------------------
    // 8. Generate and Send JWT Token
    // -----------------------------------------------------------
    console.log('🔐 Generating JWT token...');
    const token = superAdminUser.getSignedJwtToken(); // We'll add this method to the User model
    console.log('✅ JWT token generated successfully');

    console.log('🎉 Organization setup completed successfully!');
    console.log('📊 Final Summary:', {
        organization: {
            id: organization._id,
            name: organization.companyName,
            email: organization.companyEmail,
            subscriptionPlan: organization.subscriptionPlan
        },
        superAdmin: {
            id: superAdminUser._id,
            name: `${superAdminUser.firstName} ${superAdminUser.lastName}`,
            email: superAdminUser.email
        }
    });

    // Populate role for response
    await superAdminUser.populate('role', 'name priority permissions isSystemRole');

    const effectivePermissions = await getEffectivePermissionsForRole(superAdminRole);

    res.status(201).json({
        success: true,
        message: 'Organization and Super Admin initialized successfully.',
        token, // Send the token for immediate login
        user: {
            id: superAdminUser._id,
            firstName: superAdminUser.firstName,
            lastName: superAdminUser.lastName,
            email: superAdminUser.email,
            role: {
                id: superAdminRole._id,
                name: superAdminRole.name,
                priority: superAdminRole.priority,
                permissions: effectivePermissions,
                isSystemRole: superAdminRole.isSystemRole,
                description: superAdminRole.description
            },
            // Frontend: show assignee dropdown for client/case create only when true (SUPER_ADMIN has both)
            assigneePermissions: getAssigneePermissionsForRole(superAdminRole),
            organizationId: organization._id
        },
        organization: {
            id: organization._id,
            companyName: organization.companyName,
            companyEmail: organization.companyEmail,
            subscriptionPlan: organization.subscriptionPlan
        }
    });
});
