// utils/initializeSubscriptionPlans.js

const SubscriptionPlan = require('../models/SubscriptionPlan');

const defaultPlans = [
    {
        planName: 'free',
        displayName: 'Free',
        description: '14-day free trial for small organizations.',
        features: [
            'Try CaseSnap free for 14 days',
            'Create up to 2 custom roles',
            'Invite up to 2 team members',
            'Manage up to 2 clients',
            'Create up to 2 cases',
            'Assign work with up to 2 assignees'
        ],
        price: 0,
        currency: 'INR',
        billingCycle: 'trial',
        maxRoles: 2,
        maxUsers: 2,
        maxClients: 2,
        maxCases: 2,
        maxAssignees: 2,
        isActive: true
    },
    {
        planName: 'basic_monthly',
        displayName: 'Basic Monthly',
        description: 'Core CaseSnap features for small teams.',
        features: ['case_assignment', 'excel_import_export'],
        price: 999,
        currency: 'INR',
        billingCycle: 'monthly',
        maxRoles: 5,
        maxUsers: 150,
        maxClients: 150,
        maxCases: 150,
        maxAssignees: 3,
        maxExcelImportRows: 50,
        isActive: true
    },
    {
        planName: 'professional_monthly',
        displayName: 'Professional Monthly',
        description: 'Full access with approval, audit and analytics.',
        features: ['case_assignment', 'excel_import_export', 'case_approval', 'audit_logs', 'analytics'],
        price: 1999,
        currency: 'INR',
        billingCycle: 'monthly',
        maxRoles: null,
        maxUsers: null,
        maxClients: null,
        maxCases: null,
        maxAssignees: null,
        maxExcelImportRows: 100,
        isActive: true
    }
];

exports.initializeSubscriptionPlans = async () => {
    try {
        for (const plan of defaultPlans) {
            await SubscriptionPlan.updateOne(
                { planName: plan.planName },
                { $set: plan },
                { upsert: true }
            );
        }
        console.log('✅ Default subscription plans initialized');
    } catch (error) {
        console.error('❌ Error initializing subscription plans:', error.message);
    }
};
