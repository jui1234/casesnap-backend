const path = require('path');
const { BrevoClient } = require('@getbrevo/brevo');

require('dotenv').config({
    path: path.resolve(__dirname, '../../.env')
});

const getErrorDetails = (error) => error.body || error.response?.body || error.message || error;

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

const sendPasswordResetEmail = async ({ to, fullName, resetLink, organizationName = 'CaseSnap' }) => sendEmail({
    to,
    subject: `Reset your ${organizationName} password`,
    html: `
        <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
          <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px;">
            <h2 style="margin-top: 0;">Password Reset Request</h2>
            <p>Hello ${fullName || 'User'},</p>
            <p>We received a request to reset your password. Click the button below to set a new password.</p>
            <p style="text-align: center; margin: 24px 0;">
              <a href="${resetLink}" target="_blank" style="display: inline-block; text-decoration: none; color: #1f2937; background-color: #facc15; padding: 12px 24px; border-radius: 8px; font-weight: 600;">Reset Password</a>
            </p>
            <p style="font-size: 14px; color: #64748b;">This link expires in 15 minutes.</p>
            <p style="font-size: 14px; color: #64748b;">If you did not request this, please ignore this email.</p>
          </div>
        </div>
    `,
    text: `Hello ${fullName || 'User'},\n\nWe received a request to reset your password.\nReset link: ${resetLink}\n\nThis link expires in 15 minutes.\nIf you did not request this, please ignore this email.`
});

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
    testEmailConnection
};
