// utils/initializeSubscriptionPlans.js

const SubscriptionPlan = require('../models/SubscriptionPlan');

const defaultPlans = [
    {
        planName: 'free',
        displayName: 'Free',
        description: 'Basic free plan for small organizations.',
        features: [],
        price: 0,
        currency: 'INR',
        billingCycle: 'annual',
        maxUsers: 3,
        maxClients: 50,
        maxCases: 100,
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
        maxUsers: 15,
        maxClients: 250,
        maxCases: 500,
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
        maxUsers: 50,
        maxClients: 2000,
        maxCases: 4000,
        isActive: true
    }
];

exports.initializeSubscriptionPlans = async () => {
    try {
        for (const plan of defaultPlans) {
            await SubscriptionPlan.updateOne(
                { planName: plan.planName },
                { $setOnInsert: plan },
                { upsert: true }
            );
        }
        console.log('✅ Default subscription plans initialized');
    } catch (error) {
        console.error('❌ Error initializing subscription plans:', error.message);
    }
};
