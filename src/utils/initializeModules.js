// utils/initializeModules.js
// Initialize default modules in the database

const Module = require('../models/Module');

/**
 * Initialize default modules if they don't exist
 * Called during application startup
 */
exports.initializeDefaultModules = async () => {
    try {
        const defaultModules = [
            {
                name: 'client',
                displayName: 'Client',
                description: 'Client management module'
            },
            {
                name: 'cases',
                displayName: 'Cases',
                description: 'Case management module'
            },
            {
                name: 'role',
                displayName: 'Role',
                description: 'Role management module'
            },
            {
                name: 'user',
                displayName: 'User',
                description: 'User management module'
            },
            {
                name: 'subscription',
                displayName: 'Subscription',
                description: 'Subscription management module'
            }
        ];

        for (const moduleData of defaultModules) {
            const existingModule = await Module.findOne({ name: moduleData.name });
            
            if (!existingModule) {
                await Module.create(moduleData);
                console.log(`✅ Module "${moduleData.displayName}" initialized`);
            } else if (!existingModule.isActive) {
                // Reactivate if it was deactivated
                existingModule.isActive = true;
                await existingModule.save();
                console.log(`✅ Module "${moduleData.displayName}" reactivated`);
            }
        }

        console.log('✅ Default modules initialized');
    } catch (error) {
        console.error('❌ Error initializing modules:', error.message);
    }
};
