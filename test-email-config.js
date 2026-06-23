// test-email-config.js
// Script to test Brevo email configuration.

require('dotenv').config();
const { initializeEmailService, testEmailConnection, sendEmployeeInvitation } = require('./src/services/emailService');

async function testEmailConfig() {
    console.log('Testing Email Configuration...\n');

    console.log('Step 1: Checking environment variables');
    console.log('   BREVO_API_KEY:', process.env.BREVO_API_KEY ? 'Found' : 'Missing');
    console.log('   BREVO_SENDER_EMAIL:', process.env.BREVO_SENDER_EMAIL || 'Missing');
    console.log('   BREVO_SENDER_NAME:', process.env.BREVO_SENDER_NAME || 'CaseSnap');
    console.log('');

    console.log('Step 2: Initializing email service');
    const initialized = initializeEmailService();
    console.log('   Result:', initialized ? 'Initialized' : 'Failed to initialize');
    console.log('');

    console.log('Step 3: Testing email configuration');
    const connectionTest = await testEmailConnection();
    console.log('   Result:', connectionTest.success ? 'Configured' : 'Failed');
    if (!connectionTest.success) {
        console.log('   Error:', connectionTest.message || connectionTest.error);
    }
    console.log('');

    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL && process.env.TEST_EMAIL) {
        console.log('Step 4: Sending test email');
        console.log('   To:', process.env.TEST_EMAIL);

        const testEmailResult = await sendEmployeeInvitation({
            to: process.env.TEST_EMAIL,
            firstName: 'Test',
            lastName: 'User',
            organizationName: 'Test Organization',
            companyEmail: process.env.BREVO_SENDER_EMAIL,
            adminName: 'Test Admin',
            invitationLink: 'https://example.com/test-link'
        });

        if (testEmailResult.success) {
            console.log('   Test email sent successfully');
            console.log('   Message ID:', testEmailResult.messageId || 'not returned');
        } else {
            console.log('   Test email failed');
            console.log('   Error:', testEmailResult.error || testEmailResult.message);
        }
    } else {
        console.log('Step 4: Skipping test email');
        console.log('   Set BREVO_API_KEY, BREVO_SENDER_EMAIL, and TEST_EMAIL to send a test message.');
    }

    console.log('\nSummary:');
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
        console.log('Brevo email service is missing required environment variables.');
    } else if (!initialized) {
        console.log('Email service failed to initialize.');
    } else {
        console.log('Email service is configured for Brevo.');
    }
}

testEmailConfig().catch(console.error);
