// controllers/employeeController.js

const Employee = require('../models/Employee');
const Organization = require('../models/Organization');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const crypto = require('crypto');
const { sendEmployeeInvitation } = require('../services/emailService');
const jwt = require('jsonwebtoken');

// @desc      Send employee invitation
// @route     POST /api/employees/invite
// @access    Private (Admin only)
exports.sendEmployeeInvitation = asyncHandler(async (req, res, next) => {
    const { firstName, lastName, email, salary } = req.body;
    const organizationId = req.user.organization; // From JWT token

    console.log('📧 Sending employee invitation...');
    console.log('👤 Employee data:', { firstName, lastName, email, salary });
    console.log('🏢 Organization ID:', organizationId);

    // Validate required fields (only email, firstName, lastName required now)
    if (!email) {
        return next(new ErrorResponse('Email is required', 400));
    }

    if (!firstName || !lastName) {
        return next(new ErrorResponse('First name and last name are required', 400));
    }

    // Validate salary if provided
    if (salary !== undefined && salary !== null && salary !== '') {
        if (isNaN(salary) || salary < 0) {
            return next(new ErrorResponse('Salary must be a valid positive number', 400));
        }
    }

    // Check if employee already exists
    const existingEmployee = await Employee.findOne({ 
        email: email.toLowerCase(),
        organization: organizationId 
    });

    console.log('🔍 Existing employee check:', existingEmployee ? {
        id: existingEmployee._id,
        email: existingEmployee.email,
        invitationStatus: existingEmployee.invitationStatus,
        status: existingEmployee.status,
        hasAadhar: !!existingEmployee.aadharCardNumber,
        aadharValue: existingEmployee.aadharCardNumber
    } : 'No existing employee found');

    if (existingEmployee) {
        if (existingEmployee.invitationStatus === 'completed') {
            return next(new ErrorResponse('An employee with this email already exists in your organization', 400));
        } else if (existingEmployee.invitationStatus === 'pending') {
            return next(new ErrorResponse('An invitation has already been sent to this email address', 400));
        } else if (existingEmployee.invitationStatus === 'expired') {
            // Allow re-inviting expired invitations
            console.log('🔄 Re-inviting expired employee invitation');
        } else {
            // Handle any other status - treat as existing employee
            console.log('🔄 Re-inviting employee with status:', existingEmployee.invitationStatus);
        }
    }

    // Generate unique invitation token
    const invitationToken = crypto.randomBytes(32).toString('hex');
    
    // Get organization details
    const organization = await Organization.findById(organizationId);
    if (!organization) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    // Create or update employee record
    let employee;
    try {
        if (existingEmployee) {
            // Always update existing employee - only update invitation-related fields
            // Don't update fields that might already have values (like aadharCardNumber)
            const updateFields = {
                firstName,
                lastName,
                email: email.toLowerCase(),
                salary: salary || 0, // Default to 0 if not provided (will be filled during registration)
                adminId: req.user._id,
                invitationToken,
                invitationExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                invitationStatus: 'pending'
            };
            
            employee = await Employee.findByIdAndUpdate(
                existingEmployee._id,
                updateFields,
                { new: true, runValidators: false } // Don't run validators to avoid unique constraint issues
            );
            console.log('✅ Updated existing employee invitation');
        } else {
            // Create new employee record - explicitly set aadharCardNumber to undefined
            employee = await Employee.create({
                firstName,
                lastName,
                email: email.toLowerCase(),
                salary: salary || 0, // Default to 0 if not provided (will be filled during registration)
                adminId: req.user._id,
                organization: organizationId,
                invitationToken,
                invitationStatus: 'pending',
                role: 'employee', // All employees have role 'employee'
                aadharCardNumber: undefined // Explicitly set to undefined to avoid null issues
            });
            console.log('✅ Created new employee invitation');
        }
    } catch (error) {
        console.error('❌ Error creating/updating employee:', error.message);
        
        // Handle specific MongoDB errors
        if (error.message.includes('aadharCardNumber')) {
            // Try to fix the Aadhar conflict even when no existing employee is found
            console.log('🔧 Attempting to fix Aadhar conflict (no existing employee found)...');
            try {
                // Check if there's actually an employee with this email but not in our organization
                const anyEmployee = await Employee.findOne({ email: email.toLowerCase() });
                
                if (anyEmployee) {
                    console.log('🔍 Found employee in different organization:', anyEmployee.organization);
                    return next(new ErrorResponse('An employee with this email already exists in another organization.', 400));
                }
                
                // If no employee found anywhere, try creating with explicit undefined
                console.log('🔧 Creating employee with explicit undefined Aadhar...');
                employee = await Employee.create({
                    firstName,
                    lastName,
                    email: email.toLowerCase(),
                    salary: salary || 0,
                    adminId: req.user._id,
                    organization: organizationId,
                    invitationToken,
                    invitationStatus: 'pending',
                    aadharCardNumber: undefined
                });
                console.log('✅ Successfully created employee after fixing Aadhar conflict');
            } catch (fixError) {
                console.error('❌ Failed to fix Aadhar conflict:', fixError.message);
                return next(new ErrorResponse('There seems to be a data conflict. Please try with a different email address.', 400));
            }
        }
        
        // Handle duplicate key errors
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            if (field === 'aadharCardNumber') {
                // Try to fix the Aadhar conflict by updating the existing employee
                console.log('🔧 Attempting to fix Aadhar conflict by updating existing employee...');
                try {
                    const existingEmployee = await Employee.findOne({ 
                        email: email.toLowerCase(),
                        organization: organizationId 
                    });
                    
                    if (existingEmployee) {
                        // Clear the Aadhar number and update invitation details
                        existingEmployee.aadharCardNumber = undefined;
                        existingEmployee.firstName = firstName;
                        existingEmployee.lastName = lastName;
                        existingEmployee.salary = salary || 0;
                        existingEmployee.adminId = req.user._id;
                        existingEmployee.invitationToken = invitationToken;
                        existingEmployee.invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                        existingEmployee.invitationStatus = 'pending';
                        
                        employee = await existingEmployee.save();
                        console.log('✅ Fixed Aadhar conflict by updating existing employee');
                    } else {
                        return next(new ErrorResponse('Unable to resolve data conflict. Please try with a different email address.', 400));
                    }
                } catch (fixError) {
                    console.error('❌ Failed to fix Aadhar conflict:', fixError.message);
                    return next(new ErrorResponse('Unable to resolve data conflict. Please try with a different email address.', 400));
                }
            } else {
                return next(new ErrorResponse(`An employee with this ${field} already exists. Please use a different ${field}.`, 400));
            }
        }
        
        // Generic error
        return next(new ErrorResponse('Failed to create employee invitation. Please try again.', 500));
    }

    // Generate invitation link with required data
    let invitationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/employees/register?token=${invitationToken}&employeeName=${encodeURIComponent(firstName + ' ' + lastName)}&organizationName=${encodeURIComponent(organization.companyName)}&adminName=${encodeURIComponent(req.user.firstName + ' ' + req.user.lastName)}&adminId=${req.user._id}&employeeEmail=${encodeURIComponent(email)}`;
    
    // Add salary to link only if provided
    if (salary && salary > 0) {
        invitationLink += `&salary=${salary}`;
    }
    
    console.log('🔗 Invitation link generated:', invitationLink);
    console.log('🔑 Invitation token:', invitationToken);
    console.log('📧 Employee email:', email);

    // Send email with invitation link using Brevo Transactional Email API
    const emailResult = await sendEmployeeInvitation({
        to: email,
        firstName,
        lastName,
        organizationName: organization.companyName,
        companyEmail: organization.companyEmail,
        adminName: `${req.user.firstName} ${req.user.lastName}`,
        invitationLink
    });

    if (emailResult.success) {
        console.log('Email sent successfully via Brevo');
    } else {
        console.error('❌ Email sending failed!');
        console.error('   Error:', emailResult.message || emailResult.error);
        console.error('   Error Code:', emailResult.errorCode || emailResult.error || 'UNKNOWN');
        
        // Provide user-friendly error message based on error code
        if (emailResult.errorCode === 'BREVO_EMAIL_ERROR') {
            console.error('   Brevo sending error. Check BREVO_API_KEY and BREVO_SENDER_EMAIL on Render.');
        }
        
        // Still return success to user, but log the error
        // This allows the invitation link to be generated even if email fails
        // The admin can manually send the link if needed
    }

    res.status(201).json({
        success: true,
        message: 'Employee invitation sent successfully',
        data: {
            employee: {
                id: employee._id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                salary: employee.salary,
                invitationStatus: employee.invitationStatus,
                invitationExpires: employee.invitationExpires
            },
            invitationLink // For testing purposes
        }
    });
});

// @desc      Get employee by invitation token
// @route     GET /api/employees/register/:token
// @access    Public
exports.getEmployeeByToken = asyncHandler(async (req, res, next) => {
    const { token } = req.params;

    console.log('🔍 Looking up employee by invitation token:', token);

    // First try to find by invitation token (random string)
    let employee = await Employee.findOne({ 
        invitationToken: token,
        invitationStatus: 'pending'
    }).populate('organization', 'companyName companyEmail');

    // If not found by invitation token, check if it's a JWT token
    if (!employee) {
        console.log('🔍 Not found by invitation token, checking if it\'s a JWT token...');
        
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            
            console.log('🔍 JWT token decoded:', decoded);
            
            // If it's a JWT token, find employee by ID
            if (decoded.id) {
                employee = await Employee.findOne({ 
                    _id: decoded.id,
                    invitationStatus: 'pending'
                }).populate('organization', 'companyName companyEmail');
                
                if (employee) {
                    console.log('✅ Employee found by JWT token ID');
                }
            }
        } catch (jwtError) {
            console.log('🔍 Not a valid JWT token:', jwtError.message);
        }
    }

    if (!employee) {
        console.log('❌ No employee found with token:', token);
        return next(new ErrorResponse('Invalid or expired invitation link', 400));
    }

    // Check if invitation has expired
    if (employee.invitationExpires && employee.invitationExpires < new Date()) {
        employee.invitationStatus = 'expired';
        await employee.save();
        return next(new ErrorResponse('Invitation link has expired', 400));
    }

    console.log('✅ Employee found:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        organization: employee.organization?.companyName || 'N/A'
    });

    res.status(200).json({
        success: true,
        data: {
            employee: {
                id: employee._id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                salary: employee.salary,
                organization: employee.organization
            }
        }
    });
});

// @desc      Complete employee registration
// @route     POST /api/employees/register/:token
// @access    Public
exports.completeEmployeeRegistration = asyncHandler(async (req, res, next) => {
    const { token } = req.params;
    const { 
        phone, 
        address, 
        gender, 
        dateOfBirth,
        age,
        aadharCardNumber,
        employeeType,
        advocateLicenseNumber,
        internYear,
        department,
        position,
        startDate,
        emergencyContactName,
        emergencyContactPhone,
        emergencyContactRelation,
        role,
        password, 
        confirmPassword 
    } = req.body;

    console.log('📝 Completing employee registration...');
    console.log('🔑 Token:', token);
    console.log('📋 Registration data received:', { 
        phone, 
        address, 
        gender, 
        dateOfBirth,
        age,
        hasAadhar: !!aadharCardNumber,
        employeeType,
        department,
        position,
        hasPassword: !!password 
    });

    // Validate required fields for completion
    if (!phone || !address || !gender || !dateOfBirth) {
        return next(new ErrorResponse('Phone, address, gender, and date of birth are required to complete registration', 400));
    }

    // Password is required for registration completion
    if (!password || !confirmPassword) {
        return next(new ErrorResponse('Password and confirm password are required to complete registration', 400));
    }

    // Validate password
    if (password !== confirmPassword) {
        return next(new ErrorResponse('Password and confirm password do not match', 400));
    }
    if (password.length < 6) {
        return next(new ErrorResponse('Password must be at least 6 characters long', 400));
    }

    // Find employee by token
    const employee = await Employee.findOne({ 
        invitationToken: token,
        invitationStatus: 'pending'
    }).populate('organization');

    if (!employee) {
        return next(new ErrorResponse('Invalid or expired invitation link', 400));
    }

    // Check if invitation has expired
    if (employee.invitationExpires < new Date()) {
        employee.invitationStatus = 'expired';
        await employee.save();
        return next(new ErrorResponse('Invitation link has expired', 400));
    }

    // Update employee with all registration details
    employee.phone = phone;
    employee.address = address;
    employee.gender = gender;
    employee.dateOfBirth = new Date(dateOfBirth);
    
    // Set optional fields if provided
    if (age !== undefined && age !== null) {
        employee.age = age;
    }
    if (aadharCardNumber !== undefined && aadharCardNumber !== null && aadharCardNumber !== '') {
        employee.aadharCardNumber = aadharCardNumber;
    }
    if (employeeType) {
        employee.employeeType = employeeType;
    }
    if (advocateLicenseNumber) {
        employee.advocateLicenseNumber = advocateLicenseNumber;
    }
    if (internYear !== undefined && internYear !== null) {
        employee.internYear = internYear;
    }
    if (department) {
        employee.department = department;
    }
    if (position) {
        employee.position = position;
    }
    if (startDate) {
        employee.startDate = new Date(startDate);
    }
    if (emergencyContactName) {
        employee.emergencyContactName = emergencyContactName;
    }
    if (emergencyContactPhone) {
        employee.emergencyContactPhone = emergencyContactPhone;
    }
    if (emergencyContactRelation) {
        employee.emergencyContactRelation = emergencyContactRelation;
    }
    
    employee.invitationStatus = 'completed';
    employee.invitationToken = undefined; // Remove token after completion
    
    // Set role (default to 'employee' if not provided)
    employee.role = role || 'employee';
    
    // Set password (will be hashed by pre-save middleware)
    employee.password = password;
    
    // Note: Status remains 'pending' until admin activates the account

    console.log('💾 Saving employee with all registration data...');
    await employee.save();
    console.log('✅ Employee saved successfully');

    // Reload employee to get all saved fields
    const savedEmployee = await Employee.findById(employee._id)
        .populate('organization')
        .populate('adminId', 'firstName lastName email');
    
    console.log('✅ Employee registration completed:', {
        id: savedEmployee._id,
        name: `${savedEmployee.firstName} ${savedEmployee.lastName}`,
        email: savedEmployee.email,
        employeeType: savedEmployee.employeeType,
        department: savedEmployee.department,
        position: savedEmployee.position,
        status: savedEmployee.status
    });

    res.status(200).json({
        success: true,
        message: 'Employee registration completed successfully',
        data: {
            employee: {
                id: savedEmployee._id,
                firstName: savedEmployee.firstName,
                lastName: savedEmployee.lastName,
                email: savedEmployee.email,
                phone: savedEmployee.phone,
                address: savedEmployee.address,
                gender: savedEmployee.gender,
                dateOfBirth: savedEmployee.dateOfBirth,
                age: savedEmployee.age,
                aadharCardNumber: savedEmployee.aadharCardNumber,
                employeeType: savedEmployee.employeeType,
                type: savedEmployee.employeeType, // Alias for frontend compatibility
                advocateLicenseNumber: savedEmployee.advocateLicenseNumber,
                internYear: savedEmployee.internYear,
                salary: savedEmployee.salary,
                department: savedEmployee.department,
                position: savedEmployee.position,
                startDate: savedEmployee.startDate,
                emergencyContactName: savedEmployee.emergencyContactName,
                emergencyContactPhone: savedEmployee.emergencyContactPhone,
                emergencyContactRelation: savedEmployee.emergencyContactRelation,
                organization: savedEmployee.organization,
                adminId: savedEmployee.adminId,
                status: savedEmployee.status,
                invitationStatus: savedEmployee.invitationStatus,
                createdAt: savedEmployee.createdAt,
                updatedAt: savedEmployee.updatedAt
            }
        }
    });
});

// @desc      Get all employees for an organization
// @route     GET /api/employees
// @access    Private (Admin only)
exports.getEmployees = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;

    console.log('📋 Fetching employees for organization:', organizationId);

    const employees = await Employee.find({ organization: organizationId })
        .select('-invitationToken') // Exclude sensitive data
        .sort({ createdAt: -1 });

    console.log(`✅ Found ${employees.length} employees`);

    res.status(200).json({
        success: true,
        count: employees.length,
        data: employees
    });
});

// @desc      Get single employee
// @route     GET /api/employees/:id
// @access    Private (Admin only)
exports.getEmployee = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    console.log('🔍 Fetching employee:', id);

    const employee = await Employee.findOne({ 
        _id: id, 
        organization: organizationId 
    }).select('-invitationToken');

    if (!employee) {
        return next(new ErrorResponse('Employee not found', 404));
    }

    console.log('✅ Employee found:', employee.fullName);

    res.status(200).json({
        success: true,
        data: employee
    });
});

// @desc      Register new employee (Direct registration)
// @route     POST /api/employees/register
// @access    Private (Admin only)
exports.registerEmployee = asyncHandler(async (req, res, next) => {
    const {
        firstName,
        lastName,
        email,
        phone,
        address,
        gender,
        dateOfBirth,
        age,
        aadharCardNumber,
        employeeType,
        advocateLicenseNumber,
        internYear,
        salary,
        department,
        position,
        startDate,
        emergencyContactName,
        emergencyContactPhone,
        emergencyContactRelation,
        password,
        confirmPassword
    } = req.body;

    const adminId = req.user._id; // From JWT token
    const organizationId = req.user.organization; // From JWT token

    console.log('📝 Registering new employee...');
    console.log('👤 Employee data:', { firstName, lastName, email, employeeType });
    console.log('👨‍💼 Admin ID:', adminId);
    console.log('🏢 Organization ID:', organizationId);

    // Validate required fields (salary is optional - can be set by admin later)
    const requiredFields = [
        'firstName', 'lastName', 'email', 'phone', 'address', 'gender', 
        'dateOfBirth', 'age', 'aadharCardNumber', 'employeeType', 
        'department', 'position', 'startDate', 'emergencyContactName', 
        'emergencyContactPhone', 'emergencyContactRelation', 'password', 'confirmPassword'
    ];

    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
        return next(new ErrorResponse(`Missing required fields: ${missingFields.join(', ')}`, 400));
    }

    // Validate salary if provided
    if (salary !== undefined && salary !== null && salary !== '') {
        if (isNaN(salary) || salary < 0) {
            return next(new ErrorResponse('Salary must be a valid positive number', 400));
        }
    }

    // Validate password confirmation
    if (password !== confirmPassword) {
        return next(new ErrorResponse('Password and confirm password do not match', 400));
    }

    // Validate employee type specific fields
    if (employeeType === 'advocate' && !advocateLicenseNumber) {
        return next(new ErrorResponse('Advocate license number is required for advocate employees', 400));
    }

    if (employeeType === 'intern' && !internYear) {
        return next(new ErrorResponse('Intern year is required for intern employees', 400));
    }

    // Validate age calculation
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    const calculatedAge = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        calculatedAge--;
    }

    if (calculatedAge !== age) {
        return next(new ErrorResponse('Age does not match the calculated age from date of birth', 400));
    }

    // Find existing employee by email (invited employee)
    const existingEmployee = await Employee.findOne({
        email: email.toLowerCase(),
        organization: organizationId
    });

    if (!existingEmployee) {
        return next(new ErrorResponse('No invitation found for this email address. Please contact your admin to send an invitation.', 400));
    }

    // Check if employee has already completed registration
    if (existingEmployee.invitationStatus === 'completed') {
        if (existingEmployee.status === 'active') {
            return next(new ErrorResponse('You have already completed your registration and your account is active. You cannot register again.', 400));
        } else if (existingEmployee.status === 'pending') {
            return next(new ErrorResponse('You have already completed your registration. Your account is pending admin approval. Please contact your admin for status updates.', 400));
        } else {
            return next(new ErrorResponse('You have already completed your registration. Please contact your admin for account status.', 400));
        }
    }

    // Check if invitation has expired
    if (existingEmployee.invitationStatus === 'expired') {
        return next(new ErrorResponse('Your invitation has expired. Please contact your admin to send a new invitation.', 400));
    }

    // Get organization details
    const organization = await Organization.findById(organizationId);
    if (!organization) {
        return next(new ErrorResponse('Organization not found', 404));
    }

    // Update existing employee with registration details
    existingEmployee.phone = phone;
    existingEmployee.address = address;
    existingEmployee.gender = gender;
    existingEmployee.dateOfBirth = new Date(dateOfBirth);
    existingEmployee.age = age;
    existingEmployee.aadharCardNumber = aadharCardNumber;
    existingEmployee.employeeType = employeeType;
    existingEmployee.department = department;
    existingEmployee.position = position;
    existingEmployee.startDate = new Date(startDate);
    existingEmployee.emergencyContactName = emergencyContactName;
    existingEmployee.emergencyContactPhone = emergencyContactPhone;
    existingEmployee.emergencyContactRelation = emergencyContactRelation;
    existingEmployee.password = password;
    existingEmployee.invitationStatus = 'completed';
    existingEmployee.status = 'pending';
    existingEmployee.invitationToken = undefined; // Remove token after completion
    
    // Update salary only if provided (optional field - admin can set later)
    if (salary !== undefined && salary !== null && salary !== '') {
        existingEmployee.salary = salary;
    }

    // Add conditional fields based on employee type
    if (employeeType === 'advocate') {
        existingEmployee.advocateLicenseNumber = advocateLicenseNumber;
    }

    if (employeeType === 'intern') {
        existingEmployee.internYear = internYear;
    }

    // Save updated employee
    const employee = await existingEmployee.save();

    console.log('✅ Employee registered successfully:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        employeeType: employee.employeeType
    });

    // Generate JWT token for the employee
    const token = jwt.sign(
        { 
            id: employee._id,
            email: employee.email,
            organization: employee.organization,
            role: 'employee'
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
    );

    res.status(201).json({
        success: true,
        message: 'Employee registered successfully',
        token,
        data: {
            employee: {
                id: employee._id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                phone: employee.phone,
                address: employee.address,
                gender: employee.gender,
                dateOfBirth: employee.dateOfBirth,
                age: employee.age,
                aadharCardNumber: employee.aadharCardNumber,
                employeeType: employee.employeeType,
                advocateLicenseNumber: employee.advocateLicenseNumber,
                internYear: employee.internYear,
                salary: employee.salary,
                department: employee.department,
                position: employee.position,
                startDate: employee.startDate,
                emergencyContactName: employee.emergencyContactName,
                emergencyContactPhone: employee.emergencyContactPhone,
                emergencyContactRelation: employee.emergencyContactRelation,
                organization: employee.organization,
                adminId: employee.adminId,
                invitationStatus: employee.invitationStatus,
                status: employee.status,
                createdAt: employee.createdAt
            }
        }
    });
});

// @desc      Update employee status
// @route     POST /api/employees/:id/status
// @access    Private (Admin only)
exports.updateEmployeeStatus = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { status, reason, notes } = req.body;
    const organizationId = req.user.organization;

    console.log('🔄 Updating employee status...');
    console.log('👤 Employee ID:', id);
    console.log('📊 New Status:', status);
    console.log('📝 Reason:', reason);
    console.log('📄 Notes:', notes);

    // Validate status
    const validStatuses = ['pending', 'active', 'inactive', 'terminated'];
    if (!status || !validStatuses.includes(status)) {
        return next(new ErrorResponse(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400));
    }

    // Find employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId
    });

    if (!employee) {
        return next(new ErrorResponse('Employee not found', 404));
    }

    // Store previous status for logging
    const previousStatus = employee.status;

    // Update status and additional fields
    employee.status = status;
    
    // Add status change tracking (for future audit trail)
    if (!employee.statusHistory) {
        employee.statusHistory = [];
    }
    
    employee.statusHistory.push({
        from: previousStatus,
        to: status,
        changedBy: req.user._id,
        changedAt: new Date(),
        reason: reason || null,
        notes: notes || null
    });

    await employee.save();

    console.log('✅ Employee status updated:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        previousStatus: previousStatus,
        newStatus: status,
        reason: reason
    });

    // Send different messages based on status change
    let message = 'Employee status updated successfully';
    if (status === 'active' && previousStatus === 'pending') {
        message = 'Employee activated successfully. They can now login to the system.';
    } else if (status === 'inactive' && previousStatus === 'active') {
        message = 'Employee deactivated. They can no longer login to the system.';
    } else if (status === 'terminated') {
        message = 'Employee terminated. They can no longer access the system.';
    }

    res.status(200).json({
        success: true,
        message: message,
        data: {
            employee: {
                id: employee._id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                status: employee.status,
                previousStatus: previousStatus,
                updatedAt: employee.updatedAt,
                statusHistory: employee.statusHistory.slice(-3) // Last 3 status changes
            }
        }
    });
});

// @desc      Get employees by status
// @route     GET /api/employees/status/:status
// @access    Private (Admin only)
exports.getEmployeesByStatus = asyncHandler(async (req, res, next) => {
    const { status } = req.params;
    const organizationId = req.user.organization;

    console.log('📋 Fetching employees by status:', status);
    console.log('🏢 Organization ID:', organizationId);

    // Validate status
    const validStatuses = ['pending', 'active', 'inactive', 'terminated'];
    if (!validStatuses.includes(status)) {
        return next(new ErrorResponse(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400));
    }

    const employees = await Employee.find({ 
        organization: organizationId,
        status: status 
    })
        .select('-password -invitationToken') // Exclude sensitive data
        .sort({ createdAt: -1 });

    console.log(`✅ Found ${employees.length} employees with status: ${status}`);

    res.status(200).json({
        success: true,
        count: employees.length,
        status: status,
        data: employees
    });
});

// @desc      Get all employees for admin management (including soft deleted) with pagination
// @route     GET /api/employees/admin/all
// @access    Private (Admin only)
exports.getEmployeesForAdmin = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const { 
        includeDeleted = false,
        includeArchived = false,
        status, 
        role, // Filter by employeeType (role)
        department, // Filter by department
        type, // Filter by employeeType (type)
        search,
        page = 1,
        limit = 10,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;

    console.log('👨‍💼 Admin fetching employees with pagination');
    console.log('🏢 Organization ID:', organizationId);
    console.log('🔍 Include deleted:', includeDeleted);
    console.log('📦 Include archived:', includeArchived);
    console.log('📊 Status filter:', status);
    console.log('👤 Role filter:', role);
    console.log('🏢 Department filter:', department);
    console.log('📋 Type filter:', type);
    console.log('🔎 Search term:', search);
    console.log('📄 Page:', page, 'Limit:', limit);
    console.log('🔄 Sort by:', sortBy, 'Order:', sortOrder);
    
    // Debug: Check if organization ID exists
    if (!organizationId) {
        console.log('❌ DEBUG: No organization ID found in request');
        return next(new ErrorResponse('Admin organization not found', 400));
    }

    // Validate pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    if (pageNum < 1) {
        return next(new ErrorResponse('Page number must be greater than 0', 400));
    }
    
    if (limitNum < 1 || limitNum > 100) {
        return next(new ErrorResponse('Limit must be between 1 and 100', 400));
    }

    // Validate sort parameters
    const validSortFields = ['createdAt', 'updatedAt', 'firstName', 'lastName', 'email', 'salary', 'status'];
    if (!validSortFields.includes(sortBy)) {
        return next(new ErrorResponse(`Invalid sort field. Must be one of: ${validSortFields.join(', ')}`, 400));
    }

    const validSortOrders = ['asc', 'desc'];
    if (!validSortOrders.includes(sortOrder)) {
        return next(new ErrorResponse(`Invalid sort order. Must be one of: ${validSortOrders.join(', ')}`, 400));
    }

    // Build query
    let query = { organization: organizationId };

    // Include soft deleted employees if requested
    if (includeDeleted !== 'true') {
        query.isDeleted = false;
    }

    // Include archived employees if requested (default: only show employed)
    if (includeArchived !== 'true') {
        query.employmentStatus = 'employed';
    }

    // Filter by status if provided (supports single status or comma-separated multiple statuses)
    if (status && status !== 'all') {
        const validStatuses = ['pending', 'active', 'inactive', 'terminated'];
        
        // Check if multiple statuses are provided (comma-separated)
        const statusArray = status.split(',').map(s => s.trim()).filter(s => s.length > 0);
        
        if (statusArray.length === 1) {
            // Single status
            const singleStatus = statusArray[0];
            if (!validStatuses.includes(singleStatus)) {
                return next(new ErrorResponse(`Invalid status. Must be one of: ${validStatuses.join(', ')}, or 'all'`, 400));
            }
            query.status = singleStatus;
        } else if (statusArray.length > 1) {
            // Multiple statuses - use $in operator
            const invalidStatuses = statusArray.filter(s => !validStatuses.includes(s));
            if (invalidStatuses.length > 0) {
                return next(new ErrorResponse(`Invalid status(es): ${invalidStatuses.join(', ')}. Must be one of: ${validStatuses.join(', ')}`, 400));
            }
            query.status = { $in: statusArray };
            console.log('📊 Multiple status filter:', statusArray);
        }
    }

    // Filter by role if provided
    // If role is 'super-admin' or 'admin', return no employees (employees are always 'employee' role)
    if (role && role !== 'all') {
        if (role === 'super-admin' || role === 'admin') {
            // Return empty result immediately - no employees match these roles
            return res.status(200).json({
                success: true,
                count: 0,
                totalCount: 0,
                totalPages: 0,
                currentPage: pageNum,
                hasNextPage: false,
                hasPrevPage: false,
                nextPage: null,
                prevPage: null,
                data: [],
                filters: {
                    includeDeleted: includeDeleted === 'true',
                    includeArchived: includeArchived === 'true',
                    status: status || 'all',
                    role: role,
                    department: department || 'all',
                    type: type || 'all',
                    search: search || null
                },
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    sortBy: sortBy,
                    sortOrder: sortOrder
                }
            });
        } else if (role === 'employee') {
            // Filter for employees only (role = 'employee' or role doesn't exist for backward compatibility)
            query.$or = [
                { role: 'employee' },
                { role: { $exists: false } } // Include old records without role field
            ];
        }
        // If invalid role, ignore it
    }
    
    // Filter by type/employeeType if provided (separate from role filter)
    if (type && type !== 'all') {
        const validTypes = ['advocate', 'intern', 'staff', 'other'];
        if (validTypes.includes(type)) {
            query.employeeType = type;
        }
    }

    // Filter by department if provided
    if (department && department !== 'all') {
        query.department = { $regex: department, $options: 'i' };
    }

    // Search functionality - only search by employee name (firstName and lastName)
    if (search) {
        // If we already have $or from role filter, we need to combine them
        if (query.$or) {
            // We have role filter $or, need to add search $or
            // Combine both conditions with $and
            const roleCondition = query.$or;
            delete query.$or;
            query.$and = [
                { $or: roleCondition },
                { $or: [
                    { firstName: { $regex: search, $options: 'i' } },
                    { lastName: { $regex: search, $options: 'i' } }
                ]}
            ];
        } else {
            query.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } }
            ];
        }
    }

    // Calculate pagination
    const skip = (pageNum - 1) * limitNum;
    
    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Debug: Log the query being used
    console.log('🔍 DEBUG: Query object:', JSON.stringify(query, null, 2));
    
    // Get total count for pagination metadata
    const totalCount = await Employee.countDocuments(query);
    console.log('🔍 DEBUG: Total count from database:', totalCount);
    
    const totalPages = Math.ceil(totalCount / limitNum);

    // Get employees with pagination
    const employees = await Employee.find(query)
        .select('-password -invitationToken') // Exclude sensitive data
        .populate('adminId', 'firstName lastName email')
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum);

    console.log(`✅ Found ${employees.length} employees (${totalCount} total) for admin management`);
    
    // Debug: Log sample employee if found
    if (employees.length > 0) {
        console.log('🔍 DEBUG: Sample employee:', {
            id: employees[0]._id,
            name: `${employees[0].firstName} ${employees[0].lastName}`,
            email: employees[0].email,
            organization: employees[0].organization,
            status: employees[0].status,
            isDeleted: employees[0].isDeleted
        });
    } else {
        console.log('🔍 DEBUG: No employees found with current query');
        
        // Debug: Check if there are any employees at all
        const allEmployees = await Employee.find({});
        console.log('🔍 DEBUG: Total employees in database:', allEmployees.length);
        
        if (allEmployees.length > 0) {
            console.log('🔍 DEBUG: Sample employee from database:', {
                id: allEmployees[0]._id,
                name: `${allEmployees[0].firstName} ${allEmployees[0].lastName}`,
                email: allEmployees[0].email,
                organization: allEmployees[0].organization,
                status: allEmployees[0].status,
                isDeleted: allEmployees[0].isDeleted
            });
        }
    }

    // Map employees to ensure type (employeeType), department, and position are included
    const employeesWithFields = employees.map(emp => {
        const empObj = emp.toObject();
        return {
            ...empObj,
            type: empObj.employeeType || null, // Map employeeType to type
            department: empObj.department || null,
            position: empObj.position || null
        };
    });

    res.status(200).json({
        success: true,
        count: employees.length,
        totalCount: totalCount,
        totalPages: totalPages,
        currentPage: pageNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
        nextPage: pageNum < totalPages ? pageNum + 1 : null,
        prevPage: pageNum > 1 ? pageNum - 1 : null,
        data: employeesWithFields,
        filters: {
            includeDeleted: includeDeleted === 'true',
            includeArchived: includeArchived === 'true',
            status: status || 'all',
            role: role || 'all',
            department: department || 'all',
            type: type || 'all',
            search: search || null
        },
        pagination: {
            page: pageNum,
            limit: limitNum,
            sortBy: sortBy,
            sortOrder: sortOrder
        }
    });
});

// @desc      Update employee by admin
// @route     PUT /api/employees/admin/:id
// @access    Private (Admin only)
exports.updateEmployeeByAdmin = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const updateData = req.body;

    console.log('✏️ Admin updating employee:', id);
    console.log('🏢 Organization ID:', organizationId);
    console.log('📝 Update data:', updateData);

    // Find employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId,
        isDeleted: false
    });

    if (!employee) {
        return next(new ErrorResponse('Employee not found', 404));
    }

    // Validate employee type specific fields if being updated
    if (updateData.employeeType === 'advocate' && !updateData.advocateLicenseNumber) {
        return next(new ErrorResponse('Advocate license number is required for advocate employees', 400));
    }

    if (updateData.employeeType === 'intern' && !updateData.internYear) {
        return next(new ErrorResponse('Intern year is required for intern employees', 400));
    }

    // Update employee
    const updatedEmployee = await Employee.findByIdAndUpdate(
        id,
        updateData,
        { new: true, runValidators: true }
    ).select('-password -invitationToken');

    console.log('✅ Employee updated successfully:', {
        id: updatedEmployee._id,
        name: `${updatedEmployee.firstName} ${updatedEmployee.lastName}`,
        email: updatedEmployee.email
    });

    res.status(200).json({
        success: true,
        message: 'Employee updated successfully',
        data: updatedEmployee
    });
});

// @desc      Soft delete employee by admin
// @route     DELETE /api/employees/admin/:id
// @access    Private (Admin only)
exports.softDeleteEmployeeByAdmin = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    console.log('🗑️ Admin soft deleting employee:', id);
    console.log('🏢 Organization ID:', organizationId);

    // Find employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId,
        isDeleted: false
    });

    if (!employee) {
        return next(new ErrorResponse('Employee not found', 404));
    }

    // Soft delete employee
    employee.isDeleted = true;
    employee.deletedAt = new Date();
    employee.status = 'terminated'; // Also update status to terminated
    await employee.save();

    console.log('✅ Employee soft deleted successfully:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        deletedAt: employee.deletedAt
    });

    res.status(200).json({
        success: true,
        message: 'Employee deleted successfully',
        data: {
            id: employee._id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            deletedAt: employee.deletedAt,
            status: employee.status
        }
    });
});

// @desc      Restore soft deleted employee by admin
// @route     PUT /api/employees/admin/:id/restore
// @access    Private (Admin only)
exports.restoreEmployeeByAdmin = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    console.log('♻️ Admin restoring employee:', id);
    console.log('🏢 Organization ID:', organizationId);

    // Find soft deleted employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId,
        isDeleted: true
    });

    if (!employee) {
        return next(new ErrorResponse('Deleted employee not found', 404));
    }

    // Restore employee
    employee.isDeleted = false;
    employee.deletedAt = null;
    employee.status = 'pending'; // Reset to pending status
    await employee.save();

    console.log('✅ Employee restored successfully:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email
    });

    res.status(200).json({
        success: true,
        message: 'Employee restored successfully',
        data: {
            id: employee._id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            status: employee.status,
            restoredAt: new Date()
        }
    });
});

// @desc      Get employee's own profile
// @route     GET /api/employees/profile
// @access    Private (Employee only)
exports.getEmployeeProfile = asyncHandler(async (req, res, next) => {
    const employeeId = req.user._id;

    console.log('👤 Employee fetching own profile:', employeeId);

    const employee = await Employee.findById(employeeId)
        .select('-password -invitationToken') // Exclude sensitive data
        .populate('organization', 'companyName companyEmail')
        .populate('adminId', 'firstName lastName email');

    if (!employee) {
        return next(new ErrorResponse('Employee profile not found', 404));
    }

    // Check if employee is soft deleted
    if (employee.isDeleted) {
        return next(new ErrorResponse('Your account has been deactivated. Please contact your administrator.', 403));
    }

    console.log('✅ Employee profile retrieved:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email
    });

    res.status(200).json({
        success: true,
        data: {
            id: employee._id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            phone: employee.phone,
            address: employee.address,
            gender: employee.gender,
            dateOfBirth: employee.dateOfBirth,
            age: employee.age,
            aadharCardNumber: employee.aadharCardNumber,
            employeeType: employee.employeeType,
            advocateLicenseNumber: employee.advocateLicenseNumber,
            internYear: employee.internYear,
            salary: employee.salary,
            department: employee.department,
            position: employee.position,
            startDate: employee.startDate,
            emergencyContactName: employee.emergencyContactName,
            emergencyContactPhone: employee.emergencyContactPhone,
            emergencyContactRelation: employee.emergencyContactRelation,
            organization: employee.organization,
            adminId: employee.adminId,
            status: employee.status,
            createdAt: employee.createdAt,
            updatedAt: employee.updatedAt
        }
    });
});

// @desc      Update employee's own profile
// @route     PUT /api/employees/profile
// @access    Private (Employee only)
exports.updateEmployeeProfile = asyncHandler(async (req, res, next) => {
    const employeeId = req.user._id;
    const updateData = req.body;

    console.log('✏️ Employee updating own profile:', employeeId);
    console.log('📝 Update data:', updateData);

    // Find employee
    const employee = await Employee.findById(employeeId);

    if (!employee) {
        return next(new ErrorResponse('Employee profile not found', 404));
    }

    // Check if employee is soft deleted
    if (employee.isDeleted) {
        return next(new ErrorResponse('Your account has been deactivated. Please contact your administrator.', 403));
    }

    // Define allowed fields that employees can update themselves
    const allowedFields = [
        'phone',
        'address',
        'emergencyContactName',
        'emergencyContactPhone',
        'emergencyContactRelation'
    ];

    // Filter update data to only include allowed fields
    const filteredUpdateData = {};
    Object.keys(updateData).forEach(key => {
        if (allowedFields.includes(key)) {
            filteredUpdateData[key] = updateData[key];
        }
    });

    // Validate emergency contact phone if provided
    if (filteredUpdateData.emergencyContactPhone) {
        const phoneRegex = /^\d{10}$/;
        if (!phoneRegex.test(filteredUpdateData.emergencyContactPhone)) {
            return next(new ErrorResponse('Emergency contact phone must be a 10-digit number', 400));
        }
    }

    // Update employee with filtered data
    const updatedEmployee = await Employee.findByIdAndUpdate(
        employeeId,
        filteredUpdateData,
        { new: true, runValidators: true }
    ).select('-password -invitationToken');

    console.log('✅ Employee profile updated successfully:', {
        id: updatedEmployee._id,
        name: `${updatedEmployee.firstName} ${updatedEmployee.lastName}`,
        email: updatedEmployee.email
    });

    res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: {
            id: updatedEmployee._id,
            firstName: updatedEmployee.firstName,
            lastName: updatedEmployee.lastName,
            email: updatedEmployee.email,
            phone: updatedEmployee.phone,
            address: updatedEmployee.address,
            emergencyContactName: updatedEmployee.emergencyContactName,
            emergencyContactPhone: updatedEmployee.emergencyContactPhone,
            emergencyContactRelation: updatedEmployee.emergencyContactRelation,
            updatedAt: updatedEmployee.updatedAt
        }
    });
});

// @desc      Change employee's own password
// @route     PUT /api/employees/profile/password
// @access    Private (Employee only)
exports.changeEmployeePassword = asyncHandler(async (req, res, next) => {
    const employeeId = req.user._id;
    const { currentPassword, newPassword } = req.body;

    console.log('🔐 Employee changing password:', employeeId);

    // Validate required fields
    if (!currentPassword || !newPassword) {
        return next(new ErrorResponse('Current password and new password are required', 400));
    }

    // Validate new password length
    if (newPassword.length < 6) {
        return next(new ErrorResponse('New password must be at least 6 characters long', 400));
    }

    // Find employee with password field
    const employee = await Employee.findById(employeeId).select('+password');

    if (!employee) {
        return next(new ErrorResponse('Employee profile not found', 404));
    }

    // Check if employee is soft deleted
    if (employee.isDeleted) {
        return next(new ErrorResponse('Your account has been deactivated. Please contact your administrator.', 403));
    }

    // Verify current password
    const isCurrentPasswordValid = await employee.matchPassword(currentPassword);
    if (!isCurrentPasswordValid) {
        return next(new ErrorResponse('Current password is incorrect', 400));
    }

    // Update password
    employee.password = newPassword;
    await employee.save();

    console.log('✅ Employee password changed successfully:', {
        id: employee._id,
        email: employee.email
    });

    res.status(200).json({
        success: true,
        message: 'Password changed successfully'
    });
});

// @desc      Archive employee by admin (employee stops working)
// @route     POST /api/employees/admin/:id/archive
// @access    Private (Admin only)
exports.archiveEmployeeByAdmin = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { reason, notes } = req.body;
    const organizationId = req.user.organization;

    console.log('📦 Admin archiving employee:', id);
    console.log('🏢 Organization ID:', organizationId);
    console.log('📝 Archive reason:', reason);

    // Find employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId,
        isDeleted: false
    });

    if (!employee) {
        return next(new ErrorResponse('Employee not found', 404));
    }

    // Check if employee is already archived
    if (employee.employmentStatus === 'archived') {
        return next(new ErrorResponse('Employee is already archived', 400));
    }

    // Store previous status for logging
    const previousEmploymentStatus = employee.employmentStatus;
    const previousStatus = employee.status;

    // Archive employee
    employee.employmentStatus = 'archived';
    employee.archivedAt = new Date();
    employee.archivedBy = req.user._id;
    employee.archiveReason = reason || 'No reason provided';
    
    // Set status to terminated if not already
    if (employee.status !== 'terminated') {
        employee.status = 'terminated';
    }
    
    // Add to status history for audit trail
    if (!employee.statusHistory) {
        employee.statusHistory = [];
    }
    
    employee.statusHistory.push({
        from: previousStatus,
        to: 'terminated',
        changedBy: req.user._id,
        changedAt: new Date(),
        reason: 'Archived by admin',
        notes: notes || reason || 'Employee archived - stopped working'
    });

    await employee.save();

    console.log('✅ Employee archived successfully:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        previousEmploymentStatus: previousEmploymentStatus,
        newEmploymentStatus: 'archived',
        archivedAt: employee.archivedAt,
        archivedBy: req.user._id,
        reason: employee.archiveReason
    });

    res.status(200).json({
        success: true,
        message: 'Employee archived successfully. Employee data is preserved and can be unarchived if needed.',
        data: {
            id: employee._id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            employmentStatus: employee.employmentStatus,
            status: employee.status,
            archivedAt: employee.archivedAt,
            archivedBy: employee.archivedBy,
            archiveReason: employee.archiveReason
        }
    });
});

// @desc      Unarchive employee by admin (restore archived employee)
// @route     PUT /api/employees/admin/:id/unarchive
// @access    Private (Admin only)
exports.unarchiveEmployeeByAdmin = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { notes } = req.body;
    const organizationId = req.user.organization;

    console.log('📤 Admin unarchiving employee:', id);
    console.log('🏢 Organization ID:', organizationId);

    // Find archived employee
    const employee = await Employee.findOne({
        _id: id,
        organization: organizationId,
        employmentStatus: 'archived',
        isDeleted: false
    });

    if (!employee) {
        return next(new ErrorResponse('Archived employee not found', 404));
    }

    // Store previous status for logging
    const previousEmploymentStatus = employee.employmentStatus;

    // Unarchive employee
    employee.employmentStatus = 'employed';
    employee.status = 'pending'; // Reset to pending for admin to review
    
    // Clear archive fields
    const archivedInfo = {
        archivedAt: employee.archivedAt,
        archivedBy: employee.archivedBy,
        archiveReason: employee.archiveReason
    };
    
    employee.archivedAt = null;
    employee.archivedBy = null;
    employee.archiveReason = null;
    
    // Add to status history for audit trail
    if (!employee.statusHistory) {
        employee.statusHistory = [];
    }
    
    employee.statusHistory.push({
        from: 'terminated',
        to: 'pending',
        changedBy: req.user._id,
        changedAt: new Date(),
        reason: 'Unarchived by admin',
        notes: notes || 'Employee unarchived - restored to active employment'
    });

    await employee.save();

    console.log('✅ Employee unarchived successfully:', {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        previousEmploymentStatus: previousEmploymentStatus,
        newEmploymentStatus: 'employed',
        unarchivedAt: new Date(),
        unarchivedBy: req.user._id,
        previousArchiveInfo: archivedInfo
    });

    res.status(200).json({
        success: true,
        message: 'Employee unarchived successfully. Employee status set to pending for admin review.',
        data: {
            id: employee._id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            employmentStatus: employee.employmentStatus,
            status: employee.status,
            unarchivedAt: new Date(),
            previousArchiveInfo: archivedInfo
        }
    });
});
