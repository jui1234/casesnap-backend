// models/SubscriptionPlan.js

const mongoose = require('mongoose');

const SubscriptionPlanSchema = new mongoose.Schema({
    planName: {
        type: String,
        required: [true, 'Plan name is required'],
        unique: true,
        trim: true
    },
    displayName: {
        type: String,
        required: [true, 'Display name is required'],
        trim: true
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    features: {
        type: [String],
        default: []
    },
    price: {
        type: Number,
        default: 0,
        min: [0, 'Price cannot be negative']
    },
    currency: {
        type: String,
        default: 'INR',
        trim: true
    },
    billingCycle: {
        type: String,
        enum: ['monthly', 'quarterly', 'annual'],
        default: 'annual'
    },
    maxUsers: {
        type: Number,
        default: null
    },
    maxClients: {
        type: Number,
        default: null
    },
    maxCases: {
        type: Number,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('SubscriptionPlan', SubscriptionPlanSchema);
