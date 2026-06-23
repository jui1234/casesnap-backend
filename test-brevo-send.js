// test-brevo-send.js
// Test Brevo Transactional Email sending.

require('dotenv').config();
const { sendEmployeeInvitation, initializeEmailService } = require('./src/services/emailService');

async function testBrevoSend() {
    console.log('Testing Brevo Transactional Email sending...\n');

    console.log('Step 1: Checking configuration');
    console.log('   BREVO_API_KEY:', process.env.BREVO_API_KEY ? 'Found' : 'Missing');
    console.log('   BREVO_SENDER_EMAIL:', process.env.BREVO_SENDER_EMAIL || 'Missing');
    console.log('   BREVO_SENDER_NAME:', process.env.BREVO_SENDER_NAME || 'CaseSnap');
    console.log('');

    console.log('Step 2: Initializing email service');
    const initialized = initializeEmailService();
    if (!initialized) {
        console.error('Failed to initialize Brevo email service');
        return;
    }
    console.log('');

    const testEmail = process.env.TEST_EMAIL;
    if (!testEmail) {
        console.log('Skipping send test. Set TEST_EMAIL in .env to send a test message.');
        return;
    }

    console.log('Step 3: Sending test email');
    console.log('   To:', testEmail);
    console.log('   From:', process.env.BREVO_SENDER_EMAIL);
    console.log('');

    const result = await sendEmployeeInvitation({
        to: testEmail,
        firstName: 'Test',
        lastName: 'User',
        organizationName: 'Test Organization',
        companyEmail: process.env.BREVO_SENDER_EMAIL,
        adminName: 'Test Admin',
        invitationLink: 'https://example.com/test-invitation-link'
    });

    if (result.success) {
        console.log('Email sent successfully');
        console.log('Message ID:', result.messageId || 'not returned');
    } else {
        console.error('Email sending failed');
        console.error('Error:', result.error || result.message);
        console.error('Error Code:', result.errorCode);
    }
}

testBrevoSend().catch(console.error);
