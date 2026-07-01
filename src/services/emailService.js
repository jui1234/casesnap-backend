const path = require('path');
const { BrevoClient } = require('@getbrevo/brevo');

require('dotenv').config({
    path: path.resolve(__dirname, '../../.env')
});

const getErrorDetails = (error) => error.body || error.response?.body || error.message || error;

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sendEmail = async ({ to, subject, html, text }) => {
    try {
        if (!process.env.BREVO_API_KEY) {
            throw new Error('BREVO_API_KEY is not configured');
        }

        if (!process.env.BREVO_SENDER_EMAIL) {
            throw new Error('BREVO_SENDER_EMAIL is not configured');
        }

        if (!to || !subject || (!html && !text)) {
            throw new Error('Email requires to, subject, and html or text content');
        }

        const brevo = new BrevoClient({
            apiKey: process.env.BREVO_API_KEY
        });

        const emailPayload = {
            sender: {
                name: process.env.BREVO_SENDER_NAME || 'CaseSnap',
                email: process.env.BREVO_SENDER_EMAIL
            },
            to: [{ email: to }],
            subject
        };

        if (html) {
            emailPayload.htmlContent = html;
        }

        if (text) {
            emailPayload.textContent = text;
        }

        console.log('Sending email via Brevo Transactional API:', {
            to,
            subject,
            sender: emailPayload.sender.email
        });

        const response = await brevo.transactionalEmails.sendTransacEmail(emailPayload);
        console.log('Email sent successfully:', response);

        return {
            success: true,
            messageId: response.messageId,
            response
        };
    } catch (error) {
        const details = getErrorDetails(error);
        console.error('Brevo email sending failed:', details);

        return {
            success: false,
            message: 'Email sending failed',
            error: details,
            errorCode: 'BREVO_EMAIL_ERROR'
        };
    }
};

const sendEmployeeInvitation = async (emailData) => {
    const { to, firstName, lastName, organizationName, companyEmail, adminName, invitationLink } = emailData;

    return sendEmail({
        to,
        subject: `Invitation to join ${organizationName}`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <h1 style="color: #facc15; font-size: 32px; margin: 0; text-align: center;">CaseSnap</h1>
                <p style="color: #64748b; text-align: center;">Legal Case Management</p>
                <p>Dear <strong>${firstName} ${lastName}</strong>,</p>
                <p>Welcome to <strong>${organizationName}</strong>. <strong>${adminName}</strong> has invited you to complete your employee profile.</p>
                <p style="text-align: center; margin: 30px 0;">
                  <a href="${invitationLink}" target="_blank" style="display: inline-block; text-decoration: none; color: #1f2937; background-color: #facc15; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Complete Your Profile</a>
                </p>
                <p style="color: #64748b; font-size: 14px;">This invitation expires in 7 days.</p>
                <p>If you have any questions, contact <strong>${adminName}</strong> at <a href="mailto:${companyEmail}">${companyEmail}</a>.</p>
                <p>Best regards,<br /><strong>The ${organizationName} Team</strong></p>
              </div>
            </div>
        `,
        text: `Hello ${firstName} ${lastName}!\n\nYou have been invited to join ${organizationName} as an employee.\n\n${adminName} has invited you to complete your employee profile.\n\nTo complete your registration, please visit: ${invitationLink}\n\nThis invitation link will expire in 7 days.\n\nIf you have any questions, please contact ${adminName} at ${companyEmail}.\n\nBest regards,\nThe ${organizationName} Team`
    });
};

const sendUserInvitation = async (emailData) => {
    const { to, firstName, lastName, organizationName, companyEmail, adminName, roleName, invitationLink } = emailData;

    return sendEmail({
        to,
        subject: `Invitation to join ${organizationName} as ${roleName}`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <h1 style="color: #facc15; font-size: 32px; margin: 0; text-align: center;">CaseSnap</h1>
                <p style="color: #64748b; text-align: center;">Legal Case Management</p>
                <p>Dear <strong>${firstName} ${lastName}</strong>,</p>
                <p>Welcome to <strong>${organizationName}</strong>. <strong>${adminName}</strong> has invited you to join as <strong>${roleName}</strong>.</p>
                <p style="text-align: center; margin: 30px 0;">
                  <a href="${invitationLink}" target="_blank" style="display: inline-block; text-decoration: none; color: #1f2937; background-color: #facc15; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Complete Your Registration</a>
                </p>
                <p style="color: #64748b; font-size: 14px;">This invitation expires in 7 days.</p>
                <p>If you have any questions, contact <strong>${adminName}</strong> at <a href="mailto:${companyEmail}">${companyEmail}</a>.</p>
                <p>Best regards,<br /><strong>The ${organizationName} Team</strong></p>
              </div>
            </div>
        `,
        text: `Hello ${firstName} ${lastName}!\n\nYou have been invited to join ${organizationName} as ${roleName}.\n\n${adminName} has invited you to complete your registration.\n\nTo complete your registration, please visit: ${invitationLink}\n\nThis invitation link will expire in 7 days.\n\nIf you have any questions, please contact ${adminName} at ${companyEmail}.\n\nBest regards,\nThe ${organizationName} Team`
    });
};

const sendPasswordResetEmail = async ({ to, fullName, resetLink, organizationName = 'CaseSnap' }) => {
    const safeFullName = escapeHtml(fullName || 'User');
    const safeOrganizationName = escapeHtml(organizationName || 'CaseSnap');
    const safeResetLink = escapeHtml(resetLink);

    return sendEmail({
        to,
        subject: `Reset your ${organizationName || 'CaseSnap'} password`,
        html: `
        <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
          <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px;">
            <h2 style="margin-top: 0;">${safeOrganizationName} Password Reset Request</h2>
            <p>Hello ${safeFullName},</p>
            <p>We received a request to reset your password. Click the button below to set a new password.</p>
            <p style="text-align: center; margin: 24px 0;">
              <a href="${safeResetLink}" target="_blank" style="display: inline-block; text-decoration: none; color: #1f2937; background-color: #facc15; padding: 12px 24px; border-radius: 8px; font-weight: 600;">Reset Password</a>
            </p>
            <p style="font-size: 14px; color: #64748b;">This link expires in 15 minutes.</p>
            <p style="font-size: 14px; color: #64748b;">If you did not request this, please ignore this email.</p>
          </div>
        </div>
    `,
        text: `Hello ${fullName || 'User'},\n\nWe received a request to reset your password.\nReset link: ${resetLink}\n\nThis link expires in 15 minutes.\nIf you did not request this, please ignore this email.`
    });
};

const buildSetupWelcomeTemplate = ({
    eyebrow,
    title,
    intro,
    highlights,
    footerNote,
    organizationName,
    adminName,
    greeting,
    setupDetails = [],
    loginEmail
}) => {
    const safeOrganizationName = escapeHtml(organizationName || 'your organization');
    const safeAdminName = escapeHtml(adminName || 'Super Admin');
    const safeGreeting = escapeHtml(greeting || `Hello ${adminName || 'Super Admin'}`);
    const safeLoginEmail = escapeHtml(loginEmail || '');

    const highlightItems = highlights
        .map((item) => `<li style="margin: 0 0 10px 0;">${escapeHtml(item)}</li>`)
        .join('');
    const setupDetailItems = setupDetails
        .map(({ label, value }) => `<p style="margin: 4px 0 0 0;">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></p>`)
        .join('');

    return {
        html: `
            <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.6; background-color: #f8fafc; color: #0f172a; padding: 24px;">
              <div style="max-width: 640px; margin: auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">
                <div style="background-color: #111827; color: #ffffff; padding: 28px 36px;">
                  <p style="margin: 0 0 6px 0; color: #facc15; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">${escapeHtml(eyebrow)}</p>
                  <h1 style="margin: 0; font-size: 28px; line-height: 1.25;">${escapeHtml(title)}</h1>
                </div>
                <div style="padding: 34px 36px;">
                  <p style="margin-top: 0;"><strong>${safeGreeting}</strong>,</p>
                  <p>${escapeHtml(intro)}</p>
                  <div style="background-color: #fff7d6; border: 1px solid #fde68a; border-radius: 10px; padding: 18px 20px; margin: 26px 0;">
                    <p style="margin: 0 0 8px 0; font-weight: 700;">Setup details</p>
                    <p style="margin: 0;">Organization: <strong>${safeOrganizationName}</strong></p>
                    ${setupDetailItems}
                    ${safeLoginEmail ? `<p style="margin: 4px 0 0 0;">Login email: <strong>${safeLoginEmail}</strong></p>` : ''}
                  </div>
                  <p style="margin-bottom: 10px; font-weight: 700;">What's ready now</p>
                  <ul style="padding-left: 20px; margin-top: 0;">${highlightItems}</ul>
                  <p>${escapeHtml(footerNote)}</p>
                  <p style="margin-bottom: 0;">Best regards,<br /><strong>Team CaseSnap</strong></p>
                </div>
              </div>
            </div>
        `,
        text: `${greeting || `Hello ${adminName || 'Super Admin'}`},\n\n${intro}\n\nSetup details:\nOrganization: ${organizationName || 'your organization'}${setupDetails.length ? `\n${setupDetails.map(({ label, value }) => `${label}: ${value}`).join('\n')}` : ''}${loginEmail ? `\nLogin email: ${loginEmail}` : ''}\n\nWhat's ready now:\n- ${highlights.join('\n- ')}\n\n${footerNote}\n\nBest regards,\nTeam CaseSnap`
    };
};

const sendCompanyWelcomeEmail = async ({ to, organizationName, adminName, subscriptionPlan }) => {
    const template = buildSetupWelcomeTemplate({
        eyebrow: 'Organization setup complete',
        title: `${organizationName || 'Your organization'} is now on CaseSnap`,
        greeting: `Hello ${organizationName || 'Team'} Team`,
        intro: `Your organization workspace has been created successfully in CaseSnap. CaseSnap is now ready for your team to manage clients, cases, roles, and daily legal operations from one place.`,
        highlights: [
            `${adminName || 'The account owner'} has been assigned as the SUPER_ADMIN for this workspace.`,
            `The current subscription plan is ${subscriptionPlan || 'free'}.`,
            'Your team can begin onboarding users, adding clients, and creating cases.'
        ],
        footerNote: 'This is your organization confirmation email for the completed CaseSnap setup.',
        organizationName,
        adminName,
        setupDetails: [
            { label: 'Super admin', value: adminName || 'SUPER_ADMIN' },
            { label: 'Plan', value: subscriptionPlan || 'free' }
        ]
    });

    return sendEmail({
        to,
        subject: `${organizationName} workspace setup is complete`,
        ...template
    });
};

const sendSuperAdminWelcomeEmail = async ({ to, organizationName, adminName, companyEmail, subscriptionPlan }) => {
    const template = buildSetupWelcomeTemplate({
        eyebrow: 'Super admin access ready',
        title: 'Your CaseSnap super admin account is ready',
        greeting: `Hello ${adminName || 'Super Admin'}`,
        intro: `Your super admin account for ${organizationName || 'your organization'} has been created and approved. You now have full access to configure roles, manage users, and run the workspace.`,
        highlights: [
            'Your SUPER_ADMIN role has full permissions across active modules.',
            `The organization contact email is ${companyEmail || 'configured in your workspace'}.`,
            `The workspace is currently on the ${subscriptionPlan || 'free'} plan.`
        ],
        footerNote: 'For security, keep your login details private and invite team members from inside CaseSnap when you are ready.',
        organizationName,
        adminName,
        loginEmail: to
    });

    return sendEmail({
        to,
        subject: `Your ${organizationName} CaseSnap admin account is ready`,
        ...template
    });
};

const sendSubscriptionExpiredEmail = async ({ to, firstName, lastName, organizationName, previousPlan }) => {
    const safeFirstName = escapeHtml(firstName || 'Admin');
    const safeLastName = escapeHtml(lastName || '');
    const safeOrgName = escapeHtml(organizationName || 'your organization');
    const safePreviousPlan = escapeHtml(String(previousPlan || 'paid').replace(/_/g, ' '));

    return sendEmail({
        to,
        subject: `Your ${organizationName} subscription has expired — now on Free plan`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <h1 style="color: #facc15; font-size: 32px; margin: 0; text-align: center;">CaseSnap</h1>
                <p style="color: #64748b; text-align: center;">Legal Case Management</p>
                <p>Dear <strong>${safeFirstName} ${safeLastName}</strong>,</p>
                <p>Your <strong>${safeOrgName}</strong> subscription (<strong>${safePreviousPlan}</strong>) has expired. Your organization has been automatically moved to the <strong>Free plan</strong> so your team can continue to access existing data.</p>
                <div style="background-color: #fef9c3; border: 1px solid #fde68a; border-radius: 10px; padding: 18px 20px; margin: 24px 0;">
                  <p style="margin: 0 0 8px 0; font-weight: 700;">Free plan limits</p>
                  <ul style="margin: 0; padding-left: 20px;">
                    <li>Up to 2 users</li>
                    <li>Up to 2 roles</li>
                    <li>Up to 2 clients</li>
                    <li>Up to 2 cases</li>
                    <li>Up to 2 assignees per case</li>
                  </ul>
                  <p style="margin: 10px 0 0 0; font-size: 14px; color: #64748b;">Premium features (case assignment, Excel import/export, analytics, audit logs) are no longer available.</p>
                </div>
                <p>To restore full access, please contact your CaseSnap administrator to renew or upgrade your plan.</p>
                <p>Best regards,<br /><strong>Team CaseSnap</strong></p>
              </div>
            </div>
        `,
        text: `Dear ${firstName || 'Admin'} ${lastName || ''},\n\nYour ${organizationName} subscription (${String(previousPlan || 'paid').replace(/_/g, ' ')}) has expired. Your organization has been moved to the Free plan.\n\nFree plan limits:\n- 2 users\n- 2 roles\n- 2 clients\n- 2 cases\n- 2 assignees per case\n\nPremium features are no longer available. To restore full access, please renew or upgrade your plan.\n\nBest regards,\nTeam CaseSnap`
    });
};

const initializeEmailService = () => {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
        console.log('Brevo email service is not fully configured. Required env vars: BREVO_API_KEY and BREVO_SENDER_EMAIL');
        return false;
    }

    console.log('Brevo Transactional Email service initialized');
    console.log('Brevo sender email:', process.env.BREVO_SENDER_EMAIL);
    return true;
};

const testEmailConnection = async () => {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
        return { success: false, message: 'Brevo email service is not configured' };
    }

    return { success: true, message: 'Brevo email service is configured' };
};

module.exports = {
    initializeEmailService,
    sendEmail,
    sendEmployeeInvitation,
    sendUserInvitation,
    sendPasswordResetEmail,
    sendCompanyWelcomeEmail,
    sendSuperAdminWelcomeEmail,
    sendSubscriptionExpiredEmail,
    testEmailConnection
};
