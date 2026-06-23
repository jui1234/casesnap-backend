// check-server-email.js
// Check if the server is using Brevo email service correctly.

require('dotenv').config();
const fs = require('fs');

console.log('Checking server email configuration...\n');

console.log('Step 1: Environment variables');
console.log('   BREVO_API_KEY:', process.env.BREVO_API_KEY ? 'Found' : 'Missing');
console.log('   BREVO_SENDER_EMAIL:', process.env.BREVO_SENDER_EMAIL || 'Missing');
console.log('   BREVO_SENDER_NAME:', process.env.BREVO_SENDER_NAME || 'CaseSnap');
console.log('');

console.log('Step 2: Email service import');
try {
    const emailService = require('./src/services/emailService');
    console.log('   src/services/emailService.js loaded');
    console.log('   Functions available:', Object.keys(emailService).join(', '));
} catch (error) {
    console.error('   Error loading email service:', error.message);
}
console.log('');

console.log('Step 3: Controller usage');
const controllerFiles = [
    './src/controllers/authController.js',
    './src/controllers/employeeController.js',
    './src/controllers/userController.js'
];

controllerFiles.forEach((file) => {
    const code = fs.readFileSync(file, 'utf8');
    console.log(`   ${file}:`, code.includes('../services/emailService') ? 'uses Brevo email service' : 'check import');
});
console.log('');

console.log('Step 4: App initialization');
const appCode = fs.readFileSync('./src/app.js', 'utf8');
console.log('   app.js:', appCode.includes('./services/emailService') ? 'uses Brevo email service' : 'check import');
