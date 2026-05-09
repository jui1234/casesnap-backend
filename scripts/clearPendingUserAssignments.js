/**
 * One-off migration: clear case/client assignments where assignee User.status === 'pending'
 * (user not onboarded yet / not approved — should not own work).
 *
 * Usage (from repo root):
 *   node scripts/clearPendingUserAssignments.js
 *
 * Preview only (no writes):
 *   node scripts/clearPendingUserAssignments.js --dry-run
 *
 * Requires MONGO_URI in .env (same as the API).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const Client = require('../src/models/Client');

const dryRun =
    process.argv.includes('--dry-run') ||
    String(process.env.CLEAR_PENDING_ASSIGNMENTS_DRY_RUN || '').toLowerCase() === '1';

async function main() {
    if (!process.env.MONGO_URI) {
        console.error('Missing MONGO_URI in environment (.env)');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { dbName: 'casesnap' });
    console.log('Connected to MongoDB (casesnap)');

    const pendingIds = await User.distinct('_id', { status: 'pending' });
    if (!pendingIds.length) {
        console.log('No users with status "pending". Nothing to do.');
        await mongoose.disconnect();
        return;
    }
    console.log(`Found ${pendingIds.length} pending user id(s)`);

    const caseFilter = {
        assignedTo: { $in: pendingIds },
        deletedAt: null
    };
    const clientFilter = {
        assignedTo: { $in: pendingIds },
        deletedAt: null
    };

    const casesToFix = await Case.countDocuments(caseFilter);
    const clientsToFix = await Client.countDocuments(clientFilter);
    console.log(`Cases matched (assignedTo pending): ${casesToFix}`);
    console.log(`Clients matched (assignedTo pending): ${clientsToFix}`);

    if (dryRun) {
        console.log('Dry run — skipping updates. Remove --dry-run to apply.');
        await mongoose.disconnect();
        return;
    }

    const caseRes = await Case.updateMany(caseFilter, { $set: { assignedTo: null } });
    const clientRes = await Client.updateMany(clientFilter, { $set: { assignedTo: null } });

    const caseModified = caseRes.modifiedCount ?? caseRes.nModified ?? 0;
    const clientModified = clientRes.modifiedCount ?? clientRes.nModified ?? 0;
    console.log(`Cases updated: matched ${caseRes.matchedCount ?? caseRes.n ?? 0}, modified ${caseModified}`);
    console.log(`Clients updated: matched ${clientRes.matchedCount ?? clientRes.n ?? 0}, modified ${clientModified}`);

    await mongoose.disconnect();
    console.log('Done.');
}

main().catch((err) => {
    console.error(err);
    mongoose.disconnect().catch(() => {});
    process.exit(1);
});
