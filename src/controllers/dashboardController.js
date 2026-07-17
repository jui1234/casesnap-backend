// controllers/dashboardController.js
// Aggregated overview data for the frontend dashboard screen

const Case = require('../models/Case');
const Client = require('../models/Client');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const Organization = require('../models/Organization');
const asyncHandler = require('../middleware/asyncHandler');
const { getSubscriptionSummary } = require('../utils/subscriptionFeatureUtils');
const { getOrganizationIdFromUser, getEffectiveSubscriptionSummaryForUser } = require('../utils/subscriptionContext');

const RECENT_LIMIT = 5;
const UPCOMING_DAYS = 7;

/**
 * @desc    Get aggregated dashboard overview (organization, subscription, counts,
 *          upcoming hearings, notifications, recent cases/clients)
 * @route   GET /api/dashboard
 * @access  Private (admin + employee)
 */
exports.getDashboard = asyncHandler(async (req, res, next) => {
    const organizationId = getOrganizationIdFromUser(req.user);
    const userId = req.user._id.toString();

    const now = new Date();
    const upcomingWindowEnd = new Date(now.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);

    const [
        organization,
        subscriptionSummary,
        totalClients,
        activeClients,
        prospectClients,
        totalCases,
        activeCases,
        archivedCases,
        totalEmployees,
        activeEmployees,
        pendingEmployees,
        unreadNotifications,
        recentCases,
        recentClients,
        upcomingHearings,
        casesNeedingConfirmation
    ] = await Promise.all([
        Organization.findById(organizationId).lean(),
        getEffectiveSubscriptionSummaryForUser(req.user),
        Client.countDocuments({ organization: organizationId }),
        Client.countDocuments({ organization: organizationId, status: 'active' }),
        Client.countDocuments({ organization: organizationId, status: 'prospect' }),
        Case.countDocuments({ organization: organizationId }),
        Case.countDocuments({ organization: organizationId, status: 'active' }),
        Case.countDocuments({ organization: organizationId, status: 'archived' }),
        Employee.countDocuments({ organization: organizationId, isDeleted: false }),
        Employee.countDocuments({ organization: organizationId, isDeleted: false, status: 'active' }),
        Employee.countDocuments({ organization: organizationId, isDeleted: false, status: 'pending' }),
        Notification.countDocuments({ userId, organization: organizationId, read: false }),
        Case.find({ organization: organizationId })
            .sort({ createdAt: -1 })
            .limit(RECENT_LIMIT)
            .select('caseNumber caseType partyName status createdAt')
            .lean(),
        Client.find({ organization: organizationId })
            .sort({ createdAt: -1 })
            .limit(RECENT_LIMIT)
            .select('firstName lastName email phone status createdAt')
            .lean(),
        Case.find({
            organization: organizationId,
            status: 'active',
            'stages.nextDate': { $gte: now, $lte: upcomingWindowEnd }
        })
            .sort({ 'stages.nextDate': 1 })
            .limit(RECENT_LIMIT)
            .select('caseNumber caseType partyName stages')
            .lean(),
        Case.countDocuments({
            organization: organizationId,
            status: 'active',
            'stages.confirmedAt': null
        })
    ]);

    // Flatten upcoming hearing dates out of each case's stages array
    const upcomingHearingList = upcomingHearings
        .flatMap((c) =>
            (c.stages || [])
                .filter((s) => s.nextDate && new Date(s.nextDate) >= now && new Date(s.nextDate) <= upcomingWindowEnd)
                .map((s) => ({
                    caseId: c._id,
                    caseNumber: c.caseNumber,
                    caseType: c.caseType,
                    partyName: c.partyName,
                    stageName: s.stageName,
                    nextDate: s.nextDate,
                    nextDatePurpose: s.nextDatePurpose
                }))
        )
        .sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate))
        .slice(0, RECENT_LIMIT);

    res.status(200).json({
        success: true,
        data: {
            organization: organization ? {
                id: organization._id,
                companyName: organization.companyName,
                companyEmail: organization.companyEmail,
                industry: organization.industry
            } : null,
            subscription: subscriptionSummary || (organization ? getSubscriptionSummary(organization) : null),
            stats: {
                clients: {
                    total: totalClients,
                    active: activeClients,
                    prospect: prospectClients
                },
                cases: {
                    total: totalCases,
                    active: activeCases,
                    archived: archivedCases,
                    needsStageConfirmation: casesNeedingConfirmation
                },
                employees: {
                    total: totalEmployees,
                    active: activeEmployees,
                    pending: pendingEmployees
                },
                notifications: {
                    unread: unreadNotifications
                }
            },
            upcomingHearings: upcomingHearingList,
            recentCases,
            recentClients
        }
    });
});
