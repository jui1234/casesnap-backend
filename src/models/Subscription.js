// models/Subscription.js

const mongoose = require('mongoose');
const { generateSubscriptionId } = require('../utils/idGenerator');
const { normalizePlanName } = require('../utils/subscriptionFeatureUtils');

const SubscriptionSchema = new mongoose.Schema({
    _id: {
        type: String,
        default: generateSubscriptionId
    },
    organization: {
        type: String,
        ref: 'Organization',
        required: [true, 'Organization is required'],
        index: true
    },
    planName: {
        type: String,
        enum: {
            values: [
                'free',
                'base',
                'popular',
                'basic_monthly',
                'basic_yearly',
                'professional_monthly',
                'professional_yearly'
            ],
            message: 'Plan must be one of: free, base, popular, basic_monthly, basic_yearly, professional_monthly, professional_yearly'
        },
        set: normalizePlanName,
        required: [true, 'Plan name is required']
    },
    status: {
        type: String,
        enum: {
            values: ['active', 'inactive', 'cancelled', 'expired'],
            message: 'Status must be one of: active, inactive, cancelled, expired'
        },
        default: 'active'
    },
    startDate: {
        type: Date,
        required: [true, 'Start date is required'],
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: [true, 'Expiration date is required']
    },
    price: {
        type: Number,
        required: [true, 'Price is required'],
        min: [0, 'Price cannot be negative']
    },
    currency: {
        type: String,
        default: 'INR',
        trim: true
    },
    maxUsers: {
        type: Number,
        default: null, // null means unlimited
        min: [1, 'Max users must be at least 1']
    },
    maxClients: {
        type: Number,
        default: null, // null means unlimited
        min: [1, 'Max clients must be at least 1']
    },
    maxCases: {
        type: Number,
        default: null, // null means unlimited
        min: [1, 'Max cases must be at least 1']
    },
    features: {
        type: [String],
        default: []
    },
    billingCycle: {
        type: String,
        enum: {
            values: ['monthly', 'quarterly', 'annual'],
            message: 'Billing cycle must be one of: monthly, quarterly, annual'
        },
        default: 'annual'
    },
    autoRenew: {
        type: Boolean,
        default: true
    },
    notes: {
        type: String,
        trim: true
    },
    createdBy: {
        type: String,
        ref: 'User',
        required: [true, 'Creator is required']
    },
    updatedBy: {
        type: String,
        ref: 'User'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for faster queries
SubscriptionSchema.index({ organization: 1, status: 1 });
SubscriptionSchema.index({ expiresAt: 1 });

// Pre-save middleware to update timestamps
SubscriptionSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Subscription', SubscriptionSchema);
