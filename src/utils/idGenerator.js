// utils/idGenerator.js
// Custom ID generator with prefixes

const crypto = require('crypto');

/**
 * Generate a custom ID with prefix
 * @param {String} prefix - Prefix for the ID (e.g., 'organization', 'user', 'role')
 * @returns {String} Custom ID in format: prefix_randomstring
 */
const generateCustomId = (prefix) => {
    // Generate a random string (12 characters)
    const randomString = crypto.randomBytes(6).toString('hex');
    return `${prefix}_${randomString}`;
};

/**
 * Generate organization ID
 * @returns {String} organization_xxxxx
 */
const generateOrganizationId = () => {
    return generateCustomId('organization');
};

/**
 * Generate user ID
 * @returns {String} user_xxxxx
 */
const generateUserId = () => {
    return generateCustomId('user');
};

/**
 * Generate role ID
 * @returns {String} role_xxxxx
 */
const generateRoleId = () => {
    return generateCustomId('role');
};

/**
 * Generate employee ID
 * @returns {String} employee_xxxxx
 */
const generateEmployeeId = () => {
    return generateCustomId('employee');
};

/**
 * Generate client ID
 * @returns {String} client_xxxxx
 */
const generateClientId = () => {
    return generateCustomId('client');
};

/**
 * Generate case ID
 * @returns {String} case_xxxxx
 */
const generateCaseId = () => {
    return generateCustomId('case');
};

/**
 * Generate a case number
 * @returns {String} e.g. CS-<timestamp>-<random>
 */
const generateCaseNumber = () => {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `CS-${ts}-${rand}`;
};

/**
 * Generate module ID
 * @returns {String} module_xxxxx
 */
const generateModuleId = () => {
    return generateCustomId('module');
};

/**
 * Generate notification ID
 * @returns {String} notification_xxxxx
 */
const generateNotificationId = () => {
    return generateCustomId('notification');
};

/**
 * Generate subscription ID
 * @returns {String} subscription_xxxxx
 */
const generateSubscriptionId = () => {
    return generateCustomId('subscription');
};

/**
 * Validate custom ID format
 * @param {String} id - ID to validate
 * @param {String} expectedPrefix - Expected prefix
 * @returns {Boolean} True if valid
 */
const isValidCustomId = (id, expectedPrefix) => {
    if (!id || typeof id !== 'string') return false;
    const prefix = id.split('_')[0];
    return prefix === expectedPrefix && id.includes('_');
};

module.exports = {
    generateCustomId,
    generateOrganizationId,
    generateUserId,
    generateRoleId,
    generateEmployeeId,
    generateClientId,
    generateCaseId,
    generateCaseNumber,
    generateModuleId,
    generateNotificationId,
    generateSubscriptionId,
    isValidCustomId,
    generateId: generateCustomId // Alias for Module model
};
