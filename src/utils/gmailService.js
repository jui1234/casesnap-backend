// utils/gmailService.js
// Gmail SMTP service using nodemailer

const nodemailer = require('nodemailer');

const createGmailTransporter = (email, password) => {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || process.env.GMAIL_SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || process.env.GMAIL_SMTP_SECURE || 'false') === 'true',
        auth: {
            user: email,
            pass: password
        },
        connectionTimeout: Number(process.env.GMAIL_CONNECTION_TIMEOUT || 30000),
        greetingTimeout: Number(process.env.GMAIL_GREETING_TIMEOUT || 30000),
        socketTimeout: Number(process.env.GMAIL_SOCKET_TIMEOUT || 30000)
    });
};

// Initialize Gmail transporter
const initializeEmailService = () => {
    try {
        // Check if Gmail credentials are configured
        const email = process.env.SMTP_USER || process.env.GMAIL_EMAIL || process.env.GMAIL_USER;
        const password = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD;

        if (!email || !password) {
            console.log('⚠️ Gmail credentials not found in environment variables');
            console.log('📧 Email service will not send emails. Invitation links will still be generated.');
            console.log('📋 Required env vars: GMAIL_EMAIL and GMAIL_APP_PASSWORD');
            return false;
        }

        // Create transporter
        const transporter = createGmailTransporter(email, password);

        console.log('✅ Gmail SMTP service initialized');
        console.log('📧 Sender email:', email);
        return transporter;
    } catch (error) {
        console.error('❌ Gmail service initialization failed:', error.message);
        return false;
    }
};

// Send employee invitation email
const sendEmployeeInvitation = async (emailData) => {
    const { to, firstName, lastName, organizationName, companyEmail, adminName, invitationLink } = emailData;

    // Get Gmail credentials
    const fromEmail = process.env.SMTP_USER || process.env.GMAIL_EMAIL || process.env.GMAIL_USER || 'casesnap2025@gmail.com';
    const password = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD;

    // Check if Gmail is configured
    if (!fromEmail || !password) {
        console.error('❌ Gmail credentials not configured!');
        console.error('📧 Email would be sent to:', to);
        console.error('🔗 Invitation link:', invitationLink);
        console.error('⚠️ To fix this issue:');
        console.error('   1. Enable 2-Step Verification on your Gmail account');
        console.error('   2. Generate an App Password: https://myaccount.google.com/apppasswords');
        console.error('   3. Add GMAIL_EMAIL=your_email@gmail.com to your .env file');
        console.error('   4. Add GMAIL_APP_PASSWORD=your_app_password to your .env file');
        return { 
            success: false, 
            message: 'Gmail service not configured. GMAIL_EMAIL and GMAIL_APP_PASSWORD are required.',
            error: 'GMAIL_NOT_CONFIGURED'
        };
    }

    // Create transporter
    let transporter;
    try {
        transporter = createGmailTransporter(fromEmail, password);
    } catch (error) {
        console.error('❌ Failed to create Gmail transporter:', error.message);
        return { 
            success: false, 
            error: error.message,
            errorCode: 'TRANSPORTER_ERROR'
        };
    }

    // Email content
    const mailOptions = {
        from: {
            name: organizationName,
            address: fromEmail
        },
        to: to,
        subject: `Invitation to join ${organizationName}`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #facc15; font-size: 32px; margin: 0;">CaseSnap</h1>
                  <p style="color: #64748b; margin: 5px 0 0 0;">Legal Case Management</p>
                </div>

                <p style="color: #0f172a; font-weight: 500; font-size: 18px;">Dear <strong>${firstName} ${lastName}</strong>,</p>

                <p style="color: #475569; line-height: 1.6;">
                  Welcome to <strong>${organizationName}</strong>! We are thrilled to have you join our team.
                </p>

                <p style="color: #475569; line-height: 1.6;">
                  <strong>${adminName}</strong> has invited you to complete your employee profile.  
                  Please click the button below to provide your information and set up your account:
                </p>

                <div style="text-align: center; margin: 30px 0;">
                  <a
                    style="
                      display: inline-block;
                      text-decoration: none;
                      outline: none;
                      color: #1f2937;
                      background-color: #facc15;
                      padding: 14px 32px;
                      border-radius: 8px;
                      font-weight: 600;
                      font-size: 16px;
                      box-shadow: 0 4px 6px rgba(250, 204, 21, 0.3);
                    "
                    href="${invitationLink}"
                    target="_blank"
                  >
                    Complete Your Profile →
                  </a>
                </div>

                <p style="color: #64748b; font-size: 14px; line-height: 1.6;">
                  This link is unique to you and should be used to submit your personal and employment details securely.
                  <br/><br/>
                  <strong>⏰ This invitation expires in 7 days.</strong>
                </p>

                <div style="border-top: 1px solid #e2e8f0; margin: 30px 0; padding-top: 20px;">
                  <p style="color: #475569; line-height: 1.6;">
                    If you have any questions or need help, feel free to contact <strong>${adminName}</strong> at  
                    <a href="mailto:${companyEmail}" style="text-decoration: none; outline: none; color: #facc15; font-weight: 500;">${companyEmail}</a>.
                  </p>

                  <p style="color: #475569; line-height: 1.6;">
                    We look forward to welcoming you to the team and helping you get started smoothly!
                  </p>
                </div>

                <p style="color: #0f172a; margin-top: 30px;">
                  Best regards,<br />
                  <strong>The ${organizationName} Team</strong>
                </p>

                <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="color: #94a3b8; font-size: 12px; margin: 0;">
                    © 2024 CaseSnap. All rights reserved.
                  </p>
                </div>
              </div>
            </div>
        `,
        text: `
Hello ${firstName} ${lastName}!

You have been invited to join ${organizationName} as an employee.

${adminName} has invited you to complete your employee profile.

To complete your registration, please visit: ${invitationLink}

This invitation link will expire in 7 days.

If you have any questions, please contact ${adminName} at ${companyEmail}.

We look forward to welcoming you to the team and helping you get started smoothly!

Best regards,
The ${organizationName} Team
        `
    };

    try {
        console.log('📤 Attempting to send email via Gmail SMTP...');
        console.log('📧 To:', to);
        console.log('📧 From:', fromEmail);
        console.log('📧 Subject:', `Invitation to join ${organizationName}`);
        
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully via Gmail SMTP');
        console.log('📧 Sent to:', to);
        console.log('📨 Message ID:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Gmail SMTP email sending failed!');
        console.error('📧 Error message:', error.message);
        console.error('📧 Recipient email:', to);
        
        // Provide helpful error messages
        if (error.message.includes('Invalid login') || error.message.includes('authentication failed')) {
            console.error('   💡 Solution: Check your Gmail App Password');
            console.error('      → Make sure you\'re using an App Password, not your regular password');
            console.error('      → Generate one at: https://myaccount.google.com/apppasswords');
        } else if (error.message.includes('quota') || error.message.includes('limit')) {
            console.error('   💡 Solution: Gmail daily sending limit reached');
            console.error('      → Free Gmail accounts: 500 emails/day');
            console.error('      → Wait until tomorrow or upgrade to Google Workspace');
        }
        
        return { 
            success: false, 
            error: error.message,
            errorCode: 'GMAIL_ERROR'
        };
    }
};

// Test email configuration
const testEmailConnection = async () => {
    const email = process.env.SMTP_USER || process.env.GMAIL_EMAIL || process.env.GMAIL_USER;
    const password = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD;

    if (!email || !password) {
        console.log('⚠️ Gmail credentials not configured');
        return { success: false, message: 'Gmail service not initialized' };
    }

    try {
        const transporter = createGmailTransporter(email, password);

        // Verify connection
        await transporter.verify();
        console.log('✅ Gmail SMTP service is configured and ready');
        return { success: true, message: 'Gmail SMTP service is ready' };
    } catch (error) {
        console.error('❌ Gmail service connection failed:', error.message);
        return { success: false, error: error.message };
    }
};

// Send user invitation email
const sendUserInvitation = async (emailData) => {
    const { to, firstName, lastName, organizationName, companyEmail, adminName, roleName, invitationLink } = emailData;

    // Get Gmail credentials
    const fromEmail = process.env.SMTP_USER || process.env.GMAIL_EMAIL || process.env.GMAIL_USER || 'casesnap2025@gmail.com';
    const password = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD;

    // Check if Gmail is configured
    if (!fromEmail || !password) {
        console.error('❌ Gmail credentials not configured!');
        console.error('📧 Email would be sent to:', to);
        console.error('🔗 Invitation link:', invitationLink);
        console.error('⚠️ To fix this issue:');
        console.error('   1. Enable 2-Step Verification on your Gmail account');
        console.error('   2. Generate an App Password: https://myaccount.google.com/apppasswords');
        console.error('   3. Add GMAIL_EMAIL=your_email@gmail.com to your .env file');
        console.error('   4. Add GMAIL_APP_PASSWORD=your_app_password to your .env file');
        return { 
            success: false, 
            message: 'Gmail service not configured. GMAIL_EMAIL and GMAIL_APP_PASSWORD are required.',
            error: 'GMAIL_NOT_CONFIGURED'
        };
    }

    // Create transporter
    let transporter;
    try {
        transporter = createGmailTransporter(fromEmail, password);
    } catch (error) {
        console.error('❌ Failed to create Gmail transporter:', error.message);
        return { 
            success: false, 
            error: error.message,
            errorCode: 'TRANSPORTER_ERROR'
        };
    }

    // Email content
    const mailOptions = {
        from: {
            name: organizationName,
            address: fromEmail
        },
        to: to,
        subject: `Invitation to join ${organizationName} as ${roleName}`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #facc15; font-size: 32px; margin: 0;">CaseSnap</h1>
                  <p style="color: #64748b; margin: 5px 0 0 0;">Legal Case Management</p>
                </div>

                <p style="color: #0f172a; font-weight: 500; font-size: 18px;">Dear <strong>${firstName} ${lastName}</strong>,</p>

                <p style="color: #475569; line-height: 1.6;">
                  Welcome to <strong>${organizationName}</strong>! We are thrilled to have you join our team.
                </p>

                <p style="color: #475569; line-height: 1.6;">
                  <strong>${adminName}</strong> has invited you to join as <strong>${roleName}</strong>.  
                  Please click the button below to complete your registration and set up your account:
                </p>

                <div style="text-align: center; margin: 30px 0;">
                  <a
                    style="
                      display: inline-block;
                      text-decoration: none;
                      outline: none;
                      color: #1f2937;
                      background-color: #facc15;
                      padding: 14px 32px;
                      border-radius: 8px;
                      font-weight: 600;
                      font-size: 16px;
                      box-shadow: 0 4px 6px rgba(250, 204, 21, 0.3);
                    "
                    href="${invitationLink}"
                    target="_blank"
                  >
                    Complete Your Registration →
                  </a>
                </div>

                <p style="color: #64748b; font-size: 14px; line-height: 1.6;">
                  This link is unique to you and should be used to complete your registration securely.
                  <br/><br/>
                  <strong>⏰ This invitation expires in 7 days.</strong>
                </p>

                <div style="border-top: 1px solid #e2e8f0; margin: 30px 0; padding-top: 20px;">
                  <p style="color: #475569; line-height: 1.6;">
                    If you have any questions or need help, feel free to contact <strong>${adminName}</strong> at  
                    <a href="mailto:${companyEmail}" style="text-decoration: none; outline: none; color: #facc15; font-weight: 500;">${companyEmail}</a>.
                  </p>

                  <p style="color: #475569; line-height: 1.6;">
                    We look forward to welcoming you to the team and helping you get started smoothly!
                  </p>
                </div>

                <p style="color: #0f172a; margin-top: 30px;">
                  Best regards,<br />
                  <strong>The ${organizationName} Team</strong>
                </p>

                <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="color: #94a3b8; font-size: 12px; margin: 0;">
                    © 2024 CaseSnap. All rights reserved.
                  </p>
                </div>
              </div>
            </div>
        `,
        text: `
Hello ${firstName} ${lastName}!

You have been invited to join ${organizationName} as ${roleName}.

${adminName} has invited you to complete your registration.

To complete your registration, please visit: ${invitationLink}

This invitation link will expire in 7 days.

If you have any questions, please contact ${adminName} at ${companyEmail}.

We look forward to welcoming you to the team and helping you get started smoothly!

Best regards,
The ${organizationName} Team
        `
    };

    try {
        console.log('📤 Attempting to send user invitation email via Gmail SMTP...');
        console.log('📧 To:', to);
        console.log('📧 From:', fromEmail);
        console.log('📧 Subject:', `Invitation to join ${organizationName} as ${roleName}`);
        
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ User invitation email sent successfully via Gmail SMTP');
        console.log('📧 Sent to:', to);
        console.log('📨 Message ID:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Gmail SMTP email sending failed!');
        console.error('📧 Error message:', error.message);
        console.error('📧 Recipient email:', to);
        
        // Provide helpful error messages
        if (error.message.includes('Invalid login') || error.message.includes('authentication failed')) {
            console.error('   💡 Solution: Check your Gmail App Password');
            console.error('      → Make sure you\'re using an App Password, not your regular password');
            console.error('      → Generate one at: https://myaccount.google.com/apppasswords');
        } else if (error.message.includes('quota') || error.message.includes('limit')) {
            console.error('   💡 Solution: Gmail daily sending limit reached');
            console.error('      → Free Gmail accounts: 500 emails/day');
            console.error('      → Wait until tomorrow or upgrade to Google Workspace');
        }
        
        return { 
            success: false, 
            error: error.message,
            errorCode: 'GMAIL_ERROR'
        };
    }
};

// Send password reset email
const sendPasswordResetEmail = async ({ to, fullName, resetLink, organizationName = 'CaseSnap' }) => {
    const fromEmail = process.env.SMTP_USER || process.env.GMAIL_EMAIL || process.env.GMAIL_USER || 'casesnap2025@gmail.com';
    const password = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD;

    if (!fromEmail || !password) {
        return {
            success: false,
            message: 'Gmail service not configured. GMAIL_EMAIL and GMAIL_APP_PASSWORD are required.',
            error: 'GMAIL_NOT_CONFIGURED'
        };
    }

    let transporter;
    try {
        transporter = createGmailTransporter(fromEmail, password);
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'TRANSPORTER_ERROR'
        };
    }

    const mailOptions = {
        from: {
            name: organizationName,
            address: fromEmail
        },
        to,
        subject: `Reset your ${organizationName} password`,
        html: `
            <div style="font-family: system-ui, sans-serif, Arial; font-size: 16px; background-color: #f8fafc; color: #0f172a; padding: 20px;">
              <div style="max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border-radius: 12px;">
                <h2 style="margin-top: 0;">Password Reset Request</h2>
                <p>Hello ${fullName || 'User'},</p>
                <p>We received a request to reset your password. Click the button below to set a new password.</p>
                <div style="text-align: center; margin: 24px 0;">
                  <a href="${resetLink}" target="_blank" style="display: inline-block; text-decoration: none; color: #1f2937; background-color: #facc15; padding: 12px 24px; border-radius: 8px; font-weight: 600;">
                    Reset Password
                  </a>
                </div>
                <p style="font-size: 14px; color: #64748b;">This link expires in 15 minutes.</p>
                <p style="font-size: 14px; color: #64748b;">If you did not request this, please ignore this email.</p>
              </div>
            </div>
        `,
        text: `Hello ${fullName || 'User'},\n\nWe received a request to reset your password.\nReset link: ${resetLink}\n\nThis link expires in 15 minutes.\nIf you did not request this, please ignore this email.`
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GMAIL_ERROR'
        };
    }
};

module.exports = {
    initializeEmailService,
    sendEmployeeInvitation,
    sendUserInvitation,
    sendPasswordResetEmail,
    testEmailConnection
};
