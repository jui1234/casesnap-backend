const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { sendSubscriptionExpiredEmail } = require('../services/emailService');

// const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const POLL_INTERVAL_MS = 6000; // 1 minute for testing purposes

const runSubscriptionExpiryCheck = async () => {
    const now = new Date();

    // Find orgs still on a paid plan whose expiry has passed
    const expiredOrgs = await Organization.find({
        subscriptionPlan: { $ne: 'free' },
        subscriptionExpiresAt: { $ne: null, $lt: now }
    })
        .select('_id companyName subscriptionPlan superAdmin')
        .lean();

    if (expiredOrgs.length === 0) return;

    console.log(`⏰ Subscription expiry check: ${expiredOrgs.length} organization(s) to downgrade`);

    for (const org of expiredOrgs) {
        try {
            // Mark any active Subscription records for this org as expired
            await Subscription.updateMany(
                { organization: org._id, status: 'active' },
                { $set: { status: 'expired', updatedAt: now } }
            );

            // Downgrade org to free plan
            await Organization.findByIdAndUpdate(org._id, {
                subscriptionPlan: 'free',
                subscriptionStatus: 'active',
                subscriptionExpiresAt: null
            });

            console.log(`✅ Downgraded "${org.companyName}" (${org._id}) from ${org.subscriptionPlan} to free`);

            // Notify super admin by email
            if (org.superAdmin) {
                const adminUser = await User.findById(org.superAdmin)
                    .select('email firstName lastName')
                    .lean();

                if (adminUser && adminUser.email) {
                    await sendSubscriptionExpiredEmail({
                        to: adminUser.email,
                        firstName: adminUser.firstName,
                        lastName: adminUser.lastName,
                        organizationName: org.companyName,
                        previousPlan: org.subscriptionPlan
                    });
                }
            }
        } catch (err) {
            console.error(`❌ Failed to downgrade org ${org._id} (${org.companyName}):`, err.message);
        }
    }
};

const startSubscriptionExpiryJob = () => {
    runSubscriptionExpiryCheck()
        .then(() => {
            console.log('⏰ Subscription expiry job initialized');
        })
        .catch((err) => {
            console.error('⚠️ Initial subscription expiry check failed:', err.message);
        });

    setInterval(async () => {
        try {
            await runSubscriptionExpiryCheck();
        } catch (err) {
            console.error('⚠️ Subscription expiry check failed:', err.message);
        }
    }, POLL_INTERVAL_MS);
};

module.exports = {
    startSubscriptionExpiryJob,
    runSubscriptionExpiryCheck
};
