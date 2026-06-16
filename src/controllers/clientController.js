// controllers/clientController.js
// Client CRUD operations with RBAC

const Client = require('../models/Client');
const Notification = require('../models/Notification');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const {
    canAssignModule,
    getAssigneeUserIdsForModule,
    assertAssignableUserInOrg
} = require('../utils/assigneeUtils');
const { sendEncryptedJson } = require('../utils/responseEncryption');
const { parseExcelFromBuffer, writeExcelToBuffer, toSafeString, toOptionalNumber, toOptionalDate, formatMongooseErrorForUser } = require('../utils/excelUtils');
const { getExcelImportRowLimit } = require('../utils/subscriptionFeatureUtils');
const { getOrganizationIdFromUser, getEffectiveSubscriptionSummaryForUser } = require('../utils/subscriptionContext');

const canViewAllClients = (userRole) => canAssignModule(userRole, 'client');

const CLIENT_LIST_SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'companyName'];

function escapeRegexLiteral(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Multi-word search (e.g. URL `search=rohan+gupta` → "rohan gupta") matches across name fields. */
function applyClientListSearchToQuery(query, search) {
    const trimmed = String(search ?? '').trim();
    if (!trimmed) return;

    const tokens = trimmed.split(/\s+/).map((t) => escapeRegexLiteral(t)).filter(Boolean);
    if (tokens.length === 0) return;

    const orClauseForToken = (token) => ({
        $or: CLIENT_LIST_SEARCH_FIELDS.map((field) => ({
            [field]: { $regex: token, $options: 'i' }
        }))
    });

    if (tokens.length === 1) {
        query.$or = orClauseForToken(tokens[0]).$or;
        return;
    }

    query.$and = [...(query.$and || []), ...tokens.map(orClauseForToken)];
}

const CLIENT_EXCEL_SHEET = 'Clients';
const CLIENT_GENDER_ENUM = Client.schema?.path('gender')?.enumValues || ['Male', 'Female', 'Other', 'Prefer not to say'];
const CLIENT_STATUS_ENUM = Client.schema?.path('status')?.enumValues || ['active', 'inactive', 'prospect', 'archived'];
const CLIENT_EXCEL_HEADERS = [
    'firstName',
    'lastName',
    'email',
    'phone',
    'alternatePhone',
    'streetAddress',
    'city',
    'province',
    'postalCode',
    'country',
    'dateOfBirth',
    'gender',
    'occupation',
    'companyName',
    'aadharCardNumber',
    'panCardNumber',
    'fees',
    'status',
    'notes'
];

function getRemainingLimitInfo(summary, limitKey, current) {
    const max = summary?.subscriptionLimits?.[limitKey];
    if (max === null || max === undefined) return null;
    return {
        max,
        used: current,
        remaining: Math.max(max - current, 0)
    };
}

function buildRemainingImportLimitMessage(summary, label, limitInfo) {
    const planLabel = summary?.subscriptionLabel || 'Current';
    return `${planLabel} plan allows only ${limitInfo.max} ${label}. You have ${limitInfo.remaining} remaining ${label.slice(0, -1)} slot(s). Please import only ${limitInfo.remaining} ${label}.`;
}

/**
 * @desc    Create a new client
 * @route   POST /api/clients
 * @access  Private (Requires 'create' permission on 'client' module)
 */
exports.createClient = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const {
        firstName,
        lastName,
        email,
        phone,
        alternatePhone,
        streetAddress,
        city,
        province,
        postalCode,
        country,
        dateOfBirth,
        gender,
        occupation,
        companyName,
        aadharCardNumber,
        panCardNumber,
        fees,
        aadharImageUrl,
        assignedTo,
        notes
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !phone || fees === undefined) {
        return next(new ErrorResponse('First name, last name, phone, and fees are required', 400));
    }

    // Check if client with same email exists in organization
    if (email) {
        const existingClient = await Client.findOne({
            organization: organizationId,
            email: email.toLowerCase(),
            deletedAt: null
        });

        if (existingClient) {
            return next(new ErrorResponse('A client with this email already exists in your organization', 400));
        }
    }

    // Do not auto-assign to creator.
    // If assignedTo is explicitly provided, only assignees (or SUPER_ADMIN) can assign to others.
    let effectiveAssignedTo = null;
    if (assignedTo !== undefined && assignedTo !== null && String(assignedTo).trim() !== '') {
        effectiveAssignedTo = assignedTo;
        if (String(effectiveAssignedTo) !== String(userId) && req.userRole && !canAssignModule(req.userRole, 'client')) {
            return next(new ErrorResponse('You do not have permission to assign clients to other users', 403));
        }
        const assigneeCheck = await assertAssignableUserInOrg(organizationId, effectiveAssignedTo);
        if (assigneeCheck && assigneeCheck.error) {
            return next(new ErrorResponse(assigneeCheck.error, 400));
        }
    }

    // Create client
    const client = await Client.create({
        firstName,
        lastName,
        email: email ? email.toLowerCase() : undefined,
        phone,
        alternatePhone,
        streetAddress,
        city,
        province,
        postalCode,
        country: country || 'India',
        dateOfBirth,
        gender,
        occupation,
        companyName,
        aadharCardNumber,
        panCardNumber,
        fees,
        aadharImageUrl,
        assignedTo: effectiveAssignedTo,
        organization: organizationId,
        createdBy: userId,
        notes
    });

    console.log('✅ Client created:', {
        id: client._id,
        name: client.fullName,
        email: client.email,
        organization: organizationId
    });

    const creatorIdStr = userId.toString();
    const clientName = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'New client';

    // When creator does NOT have assignee permission, notify assignees so they see the new client
    const creatorHasAssignee = req.userRole && canAssignModule(req.userRole, 'client');
    if (!creatorHasAssignee) {
        try {
            const assigneeUserIds = await getAssigneeUserIdsForModule(organizationId, 'client');
            const recipientIds = assigneeUserIds.filter((id) => id !== creatorIdStr);
            for (const assigneeId of recipientIds) {
                await Notification.create({
                    userId: assigneeId,
                    organization: organizationId,
                    type: 'client_created',
                    title: 'New client created',
                    message: `${clientName} was created and may need to be assigned.`,
                    relatedEntityType: 'client',
                    relatedEntityId: client._id.toString(),
                    createdBy: creatorIdStr
                });
            }
            if (recipientIds.length > 0) {
                console.log('📬 Notified', recipientIds.length, 'assignee(s) of new client');
            }
        } catch (notifErr) {
            console.error('⚠️ Failed to create assignee notifications:', notifErr.message);
        }
    }

    // Notify the assigned user when creator assigns to someone else during creation
    if (effectiveAssignedTo && String(effectiveAssignedTo) !== creatorIdStr) {
        try {
            await Notification.create({
                userId: String(effectiveAssignedTo),
                organization: organizationId,
                type: 'client_assigned',
                title: 'Client assigned to you',
                message: `${clientName} has been assigned to you.`,
                relatedEntityType: 'client',
                relatedEntityId: client._id.toString(),
                createdBy: creatorIdStr
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create client_assigned notification:', notifErr.message);
        }
    }

    res.status(201).json({
        success: true,
        message: 'Client created successfully',
        data: client
    });
});

const MAX_BULK_ASSIGN_CLIENTS = 2000;

function normalizeClientIdList(rawIds) {
    return [...new Set((rawIds || []).map((id) => String(id ?? '').trim()).filter(Boolean))];
}

/**
 * @desc    Bulk assign clients to user(s) (or unassign). SUPER_ADMIN or client-module assignees only.
 * @route   POST /api/clients/bulk-assign
 * @access  Private — `client` read + client assignee (see rbac.requireClientBulkAssignAccess)
 * @body    Mode A — one assignee for many clients:
 *          { clientIds: string[], assignedTo?: string | null }
 *          Mode B — many assignees in one request (each group: many clients → one user):
 *          { groups: Array<{ clientIds: string[], assignedTo?: string | null }> }
 *          Use `assignedTo: null` or omit to clear assignment for that group. Each client may appear in only one group.
 */
exports.bulkAssignClients = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;
    const updatedByStr = userId && userId.toString ? userId.toString() : String(userId);

    const { clientIds, assignedTo, groups } = req.body;

    const useGroups = Array.isArray(groups) && groups.length > 0;

    if (useGroups) {
        const seenClients = new Set();
        const normalizedGroups = [];

        for (let i = 0; i < groups.length; i++) {
            const g = groups[i] || {};
            const ids = normalizeClientIdList(g.clientIds);
            if (ids.length === 0) {
                return next(new ErrorResponse(`groups[${i}].clientIds must contain at least one client ID`, 400));
            }
            for (const id of ids) {
                if (seenClients.has(id)) {
                    return next(
                        new ErrorResponse(
                            `Each client can only appear once across groups (duplicate: ${id})`,
                            400
                        )
                    );
                }
                seenClients.add(id);
            }
            normalizedGroups.push({ clientIds: ids, assignedTo: g.assignedTo });
        }

        if (seenClients.size > MAX_BULK_ASSIGN_CLIENTS) {
            return next(new ErrorResponse(`At most ${MAX_BULK_ASSIGN_CLIENTS} distinct clients per request`, 400));
        }

        const assigneeIdsToCheck = new Set();
        for (const g of normalizedGroups) {
            if (g.assignedTo !== undefined && g.assignedTo !== null && String(g.assignedTo).trim() !== '') {
                assigneeIdsToCheck.add(String(g.assignedTo).trim());
            }
        }

        for (const aid of assigneeIdsToCheck) {
            const check = await assertAssignableUserInOrg(organizationId, aid);
            if (check.error) return next(new ErrorResponse(`${check.error} (userId: ${aid})`, 400));
        }

        const groupResults = [];
        let totalRequested = 0;
        let totalMatched = 0;
        let totalModified = 0;

        for (let i = 0; i < normalizedGroups.length; i++) {
            const { clientIds: gIds, assignedTo: gAssign } = normalizedGroups[i];
            totalRequested += gIds.length;

            let targetAssignedTo = null;
            if (gAssign !== undefined && gAssign !== null && String(gAssign).trim() !== '') {
                targetAssignedTo = String(gAssign).trim();
            }

            const existing = await Client.find({
                _id: { $in: gIds },
                organization: organizationId,
                deletedAt: null
            })
                .select('_id')
                .lean();

            const matchedIds = existing.map((c) => c._id.toString());
            const matchedSet = new Set(matchedIds);
            const missingIds = gIds.filter((id) => !matchedSet.has(id));

            let matchedCount = 0;
            let modifiedCount = 0;
            if (matchedIds.length > 0) {
                const updateResult = await Client.updateMany(
                    {
                        _id: { $in: matchedIds },
                        organization: organizationId,
                        deletedAt: null
                    },
                    {
                        $set: {
                            assignedTo: targetAssignedTo,
                            updatedBy: updatedByStr
                        }
                    }
                );
                matchedCount = updateResult.matchedCount ?? updateResult.nMatched ?? matchedIds.length;
                modifiedCount = updateResult.modifiedCount ?? updateResult.nModified ?? 0;
            }

            totalMatched += matchedCount;
            totalModified += modifiedCount;

            if (targetAssignedTo && modifiedCount > 0) {
                try {
                    await Notification.create({
                        userId: targetAssignedTo,
                        organization: organizationId,
                        type: 'client_assigned',
                        title: 'Clients assigned to you',
                        message: `${modifiedCount} client(s) have been assigned to you.`,
                        relatedEntityType: 'client',
                        relatedEntityId: null,
                        createdBy: updatedByStr
                    });
                } catch (notifErr) {
                    console.error('⚠️ Failed to create client_assigned notification:', notifErr.message);
                }
            }

            groupResults.push({
                groupIndex: i,
                assignedTo: targetAssignedTo,
                requested: gIds.length,
                matched: matchedCount,
                modified: modifiedCount,
                missingIds:
                    missingIds.length <= 50
                        ? missingIds
                        : missingIds.slice(0, 50).concat([`(+${missingIds.length - 50} more not listed)`])
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Bulk assign completed (grouped)',
            data: {
                mode: 'groups',
                groupCount: normalizedGroups.length,
                requested: totalRequested,
                matched: totalMatched,
                modified: totalModified,
                groups: groupResults
            }
        });
    }

    if (!Array.isArray(clientIds) || clientIds.length === 0) {
        return next(
            new ErrorResponse(
                'Send either { clientIds, assignedTo } for one assignee, or { groups: [{ clientIds, assignedTo }, ...] } for multiple assignees',
                400
            )
        );
    }
    if (clientIds.length > MAX_BULK_ASSIGN_CLIENTS) {
        return next(new ErrorResponse(`At most ${MAX_BULK_ASSIGN_CLIENTS} clients per request`, 400));
    }

    const uniqueIds = normalizeClientIdList(clientIds);
    if (uniqueIds.length === 0) {
        return next(new ErrorResponse('clientIds must contain at least one valid client ID', 400));
    }

    const assigneeCheck = await assertAssignableUserInOrg(organizationId, assignedTo);
    if (assigneeCheck && assigneeCheck.error) {
        return next(new ErrorResponse(assigneeCheck.error, 400));
    }
    const targetAssignedTo = assigneeCheck ? assigneeCheck.assignedTo : null;

    const existing = await Client.find({
        _id: { $in: uniqueIds },
        organization: organizationId,
        deletedAt: null
    })
        .select('_id')
        .lean();

    const matchedIds = existing.map((c) => c._id.toString());
    const matchedSet = new Set(matchedIds);

    if (matchedIds.length === 0) {
        return res.status(200).json({
            success: true,
            message: 'No matching clients updated',
            data: {
                mode: 'single',
                requested: uniqueIds.length,
                matched: 0,
                modified: 0,
                missingIds: uniqueIds.slice(0, 100)
            }
        });
    }

    const updateResult = await Client.updateMany(
        {
            _id: { $in: matchedIds },
            organization: organizationId,
            deletedAt: null
        },
        {
            $set: {
                assignedTo: targetAssignedTo,
                updatedBy: updatedByStr
            }
        }
    );

    const matchedCount = updateResult.matchedCount ?? updateResult.nMatched ?? matchedIds.length;
    const modifiedCount = updateResult.modifiedCount ?? updateResult.nModified ?? 0;
    const missingIds = uniqueIds.filter((id) => !matchedSet.has(id));

    if (targetAssignedTo && modifiedCount > 0) {
        try {
            await Notification.create({
                userId: targetAssignedTo,
                organization: organizationId,
                type: 'client_assigned',
                title: 'Clients assigned to you',
                message: `${modifiedCount} client(s) have been assigned to you.`,
                relatedEntityType: 'client',
                relatedEntityId: null,
                createdBy: updatedByStr
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create client_assigned notification:', notifErr.message);
        }
    }

    return res.status(200).json({
        success: true,
        message: 'Bulk assign completed',
        data: {
            mode: 'single',
            requested: uniqueIds.length,
            matched: matchedCount,
            modified: modifiedCount,
            assignedTo: targetAssignedTo,
            missingIds:
                missingIds.length <= 100
                    ? missingIds
                    : missingIds.slice(0, 100).concat([`(+${missingIds.length - 100} more not listed)`])
        }
    });
});

/**
 * @desc    Get all clients with pagination and filters
 * @route   GET /api/clients
 * @access  Private (Requires 'read' permission on 'client' module)
 */
exports.getClients = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;
    const {
        page = 1,
        limit = 10,
        status,
        assignedTo,
        assignmentFilter,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        includeDeleted = false
    } = req.query;

    // Build query
    const query = {
        organization: organizationId
    };

    const showDeleted = includeDeleted === true || includeDeleted === 'true';
    if (!showDeleted) {
        query.deletedAt = null;
    }

    if (status) {
        query.status = status;
    }

    if (assignedTo) {
        query.assignedTo = assignedTo;
    }

    if (assignmentFilter === 'assigned') {
        query.assignedTo = { $ne: null };
    } else if (assignmentFilter === 'unassigned') {
        query.assignedTo = null;
    }

    // Visibility rule: users without assignee permission can only view their assigned clients.
    if (!canViewAllClients(req.userRole)) {
        query.assignedTo = userId;
    }

    if (search) {
        applyClientListSearchToQuery(query, search);
    }

    // Pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const findOptions = showDeleted ? { includeDeleted: true } : {};
    const findQuery = Client.find(query).setOptions(findOptions);
    const countQuery = Client.countDocuments(query).setOptions(findOptions);

    // Execute query
    const clients = await findQuery
        .populate('assignedTo', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(limitNum)
        .lean({ virtuals: true });

    // Get total count
    const total = await countQuery;

    sendEncryptedJson(res, 200, {
        success: true,
        count: clients.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        data: clients
    });
});

/**
 * @desc    Get single client by ID
 * @route   GET /api/clients/:id
 * @access  Private (Requires 'read' permission on 'client' module)
 */
exports.getClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    })
        .populate('assignedTo', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .populate('updatedBy', 'firstName lastName email');

    if (!client) {
        return next(new ErrorResponse('Client not found', 404));
    }

    // Visibility rule on detail endpoint as well.
    if (!canViewAllClients(req.userRole) && String(client.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to view this client', 403));
    }

    const data = client.toObject ? client.toObject() : client;
    data.aadharImageUrl = client.aadharImageUrl ?? null;

    sendEncryptedJson(res, 200, { success: true, data });
});

/**
 * @desc    Update client
 * @route   PUT /api/clients/:id
 * @access  Private (Requires 'update' permission on 'client' module)
 */
exports.updateClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    let client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!client) {
        return next(new ErrorResponse('Client not found', 404));
    }

    // Check if email is being changed and if new email already exists
    if (req.body.email && req.body.email.toLowerCase() !== client.email) {
        const existingClient = await Client.findOne({
            organization: organizationId,
            email: req.body.email.toLowerCase(),
            _id: { $ne: id },
            deletedAt: null
        });

        if (existingClient) {
            return next(new ErrorResponse('A client with this email already exists', 400));
        }
    }

    // Changing assignedTo: SUPER_ADMIN can always assign; others need 'assignee' on client
    if (req.body.assignedTo !== undefined && String(req.body.assignedTo) !== String(client.assignedTo)) {
        if (!req.userRole || !canAssignModule(req.userRole, 'client')) {
            return next(new ErrorResponse('You do not have permission to assign clients to other users', 403));
        }
    }

    if (req.body.assignedTo !== undefined) {
        const rawAssigned = req.body.assignedTo;
        if (rawAssigned !== null && String(rawAssigned).trim() !== '') {
            const assigneeCheck = await assertAssignableUserInOrg(organizationId, rawAssigned);
            if (assigneeCheck && assigneeCheck.error) {
                return next(new ErrorResponse(assigneeCheck.error, 400));
            }
        }
    }

    // Capture previous assignee before any update so we can detect a change
    const previousAssignedTo = client.assignedTo ? String(client.assignedTo) : null;

    // Update fields
    const updateFields = [
        'firstName', 'lastName', 'email', 'phone', 'alternatePhone',
        'streetAddress', 'city', 'province', 'postalCode', 'country',
        'dateOfBirth', 'gender', 'occupation', 'companyName',
        'aadharCardNumber', 'panCardNumber', 'fees',
        'aadharImageUrl',
        'assignedTo', 'status', 'notes'
    ];

    updateFields.forEach(field => {
        if (req.body[field] !== undefined) {
            client[field] = field === 'email' ? req.body[field].toLowerCase() : req.body[field];
        }
    });

    client.updatedBy = userId;
    await client.save();

    // Notify new assignee when assignment changes to a different user
    const newAssignedTo = client.assignedTo ? String(client.assignedTo) : null;
    const updaterIdStr = userId.toString();
    if (req.body.assignedTo !== undefined && newAssignedTo && newAssignedTo !== previousAssignedTo && newAssignedTo !== updaterIdStr) {
        try {
            const clientName = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'A client';
            await Notification.create({
                userId: newAssignedTo,
                organization: organizationId,
                type: 'client_assigned',
                title: 'Client assigned to you',
                message: `${clientName} has been assigned to you.`,
                relatedEntityType: 'client',
                relatedEntityId: client._id.toString(),
                createdBy: updaterIdStr
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create client_assigned notification:', notifErr.message);
        }
    }

    // Populate before sending response
    await client.populate('assignedTo', 'firstName lastName email');
    await client.populate('createdBy', 'firstName lastName email');
    await client.populate('updatedBy', 'firstName lastName email');

    console.log('✅ Client updated:', {
        id: client._id,
        name: client.fullName
    });

    res.status(200).json({
        success: true,
        message: 'Client updated successfully',
        data: client
    });
});

/**
 * @desc    Delete client (soft delete)
 * @route   DELETE /api/clients/:id
 * @access  Private (Requires 'delete' permission on 'client' module)
 */
exports.deleteClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!client) {
        return next(new ErrorResponse('Client not found', 404));
    }

    // Soft delete
    client.deletedAt = new Date();
    client.deletedBy = userId;
    client.status = 'inactive';
    await client.save();

    console.log('✅ Client deleted:', {
        id: client._id,
        name: client.fullName
    });

    res.status(200).json({
        success: true,
        message: 'Client deleted successfully'
    });
});

/**
 * @desc    Restore deleted client
 * @route   PUT /api/clients/:id/restore
 * @access  Private (Requires 'update' permission on 'client' module)
 */
exports.restoreClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: { $ne: null }
    }).setOptions({ includeDeleted: true });

    if (!client) {
        return next(new ErrorResponse('Deleted client not found', 404));
    }

    // Visibility: non-assignees can only restore clients assigned to them
    if (!canViewAllClients(req.userRole) && String(client.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to restore this client', 403));
    }

    client.deletedAt = null;
    client.deletedBy = null;
    client.status = 'active';
    await client.save();

    res.status(200).json({
        success: true,
        message: 'Client restored successfully',
        data: client
    });
});

/**
 * @desc    Archive client
 * @route   PUT /api/clients/:id/archive
 * @access  Private (Requires 'update' permission on 'client' module)
 */
exports.archiveClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    const client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!client) {
        return next(new ErrorResponse('Client not found', 404));
    }

    client.status = 'archived';
    await client.save();

    res.status(200).json({
        success: true,
        message: 'Client archived successfully',
        data: client
    });
});

/**
 * @desc    Unarchive client
 * @route   PUT /api/clients/:id/unarchive
 * @access  Private (Requires 'update' permission on 'client' module)
 */
exports.unarchiveClient = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;

    const client = await Client.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!client) {
        return next(new ErrorResponse('Client not found', 404));
    }

    client.status = 'active';
    await client.save();

    res.status(200).json({
        success: true,
        message: 'Client unarchived successfully',
        data: client
    });
});

/**
 * @desc    Download client Excel template (strict headers)
 * @route   GET /api/clients/excel/template
 * @access  Private (Requires 'read' permission on 'client' module)
 */
exports.downloadClientExcelTemplate = asyncHandler(async (req, res) => {
    const buffer = writeExcelToBuffer({
        sheetName: CLIENT_EXCEL_SHEET,
        headers: CLIENT_EXCEL_HEADERS,
        rows: []
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="clients-template.xlsx"');
    res.status(200).send(buffer);
});

/**
 * @desc    Export clients to Excel (matches list visibility rules)
 * @route   GET /api/clients/excel/export
 * @access  Private (Requires 'read' permission on 'client' module)
 */
exports.exportClientsToExcel = asyncHandler(async (req, res) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const {
        status,
        assignedTo,
        assignmentFilter,
        search,
        includeDeleted = false,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;

    const query = { organization: organizationId };
    const showDeleted = includeDeleted === true || includeDeleted === 'true';
    if (!showDeleted) query.deletedAt = null;

    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;

    if (assignmentFilter === 'assigned') query.assignedTo = { $ne: null };
    else if (assignmentFilter === 'unassigned') query.assignedTo = null;

    if (!canViewAllClients(req.userRole)) {
        query.assignedTo = userId;
    }

    if (search) {
        applyClientListSearchToQuery(query, search);
    }

    const findOptions = showDeleted ? { includeDeleted: true } : {};
    const clients = await Client.find(query)
        .setOptions(findOptions)
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .lean({ virtuals: true });

    const rows = clients.map((c) => ({
        firstName: c.firstName ?? '',
        lastName: c.lastName ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
        alternatePhone: c.alternatePhone ?? '',
        streetAddress: c.streetAddress ?? '',
        city: c.city ?? '',
        province: c.province ?? '',
        postalCode: c.postalCode ?? '',
        country: c.country ?? 'India',
        dateOfBirth: c.dateOfBirth ? new Date(c.dateOfBirth).toISOString().slice(0, 10) : '',
        gender: c.gender ?? '',
        occupation: c.occupation ?? '',
        companyName: c.companyName ?? '',
        aadharCardNumber: c.aadharCardNumber ?? '',
        panCardNumber: c.panCardNumber ?? '',
        fees: c.fees ?? '',
        status: c.status ?? 'active',
        notes: c.notes ?? ''
    }));

    const buffer = writeExcelToBuffer({
        sheetName: CLIENT_EXCEL_SHEET,
        headers: CLIENT_EXCEL_HEADERS,
        rows
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="clients-export.xlsx"');
    res.status(200).send(buffer);
});

/**
 * @desc    Import clients from Excel (strict template + row validations)
 * @route   POST /api/clients/excel/import
 * @access  Private (Requires 'create' permission on 'client' module)
 */
exports.importClientsFromExcel = asyncHandler(async (req, res, next) => {
    const organizationId = getOrganizationIdFromUser(req.user);
    const userId = req.user._id;
    const importerIsAssignee = req.userRole && canAssignModule(req.userRole, 'client');
    const subscriptionSummary = await getEffectiveSubscriptionSummaryForUser(req.user);
    const importRowLimit = getExcelImportRowLimit(subscriptionSummary?.subscriptionPlan);

    const file = req.file;
    if (!file || !file.buffer) {
        return next(new ErrorResponse('Excel file is required (form-data field: file)', 400));
    }

    const parsed = parseExcelFromBuffer(file.buffer, {
        sheetName: CLIENT_EXCEL_SHEET,
        expectedHeaders: CLIENT_EXCEL_HEADERS,
        maxRows: importRowLimit
    });

    if (!parsed.ok) {
        return next(new ErrorResponse(parsed.error, 400));
    }

    const errors = [];
    let skippedCount = 0;
    const pendingClients = [];
    const currentClientCount = await Client.countDocuments({ organization: organizationId, deletedAt: null });
    const clientLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxClients', currentClientCount);

    for (const row of parsed.rows) {
        const r = row.rowNumber;
        const d = row.data;

        const firstName = toSafeString(d.firstName);
        const lastName = toSafeString(d.lastName);
        const email = toSafeString(d.email).toLowerCase() || undefined;
        const phoneRaw = toSafeString(d.phone);
        const phone = phoneRaw ? phoneRaw.replace(/\D/g, '') : '';
        const alternatePhoneRaw = toSafeString(d.alternatePhone);
        const alternatePhone = alternatePhoneRaw ? alternatePhoneRaw.replace(/\D/g, '') : undefined;
        const streetAddress = toSafeString(d.streetAddress);
        const city = toSafeString(d.city);
        const province = toSafeString(d.province);
        const postalCode = toSafeString(d.postalCode);
        const country = toSafeString(d.country) || 'India';
        const dateOfBirth = toOptionalDate(d.dateOfBirth);
        const gender = toSafeString(d.gender) || undefined;
        const occupation = toSafeString(d.occupation) || undefined;
        const companyName = toSafeString(d.companyName) || undefined;
        const aadharCardNumber = toSafeString(d.aadharCardNumber) || undefined;
        const panCardNumber = toSafeString(d.panCardNumber) || undefined;
        const fees = toOptionalNumber(d.fees);
        const status = toSafeString(d.status) || undefined;
        const notes = toSafeString(d.notes) || undefined;

        const rowIssues = [];
        if (!firstName) rowIssues.push('firstName is required');
        if (!lastName) rowIssues.push('lastName is required');
        if (!phone) rowIssues.push('phone is required');
        if (phone && phone.length !== 10) rowIssues.push('phone must be a 10-digit number');
        if (alternatePhone && alternatePhone.length !== 10) rowIssues.push('alternatePhone must be a 10-digit number');
        if (!streetAddress) rowIssues.push('streetAddress is required');
        if (!city) rowIssues.push('city is required');
        if (!province) rowIssues.push('province is required');
        if (!postalCode) rowIssues.push('postalCode is required');
        if (fees === undefined || Number.isNaN(fees)) rowIssues.push('fees is required and must be a number');
        if (dateOfBirth !== undefined && Number.isNaN(dateOfBirth)) rowIssues.push('dateOfBirth must be a valid date');
        if (gender && !CLIENT_GENDER_ENUM.includes(gender)) rowIssues.push(`gender must be one of: ${CLIENT_GENDER_ENUM.join(', ')}`);
        if (status && !CLIENT_STATUS_ENUM.includes(status)) rowIssues.push(`status must be one of: ${CLIENT_STATUS_ENUM.join(', ')}`);

        if (rowIssues.length > 0) {
            errors.push({ row: r, errors: rowIssues });
            skippedCount++;
            continue;
        }

        if (email) {
            const existingClient = await Client.findOne({
                organization: organizationId,
                email,
                deletedAt: null
            }).lean();
            if (existingClient) {
                errors.push({ row: r, errors: ['A client with this email already exists'] });
                skippedCount++;
                continue;
            }
        }

        pendingClients.push({
            row: r,
            doc: {
                firstName,
                lastName,
                email,
                phone,
                alternatePhone,
                streetAddress,
                city,
                province,
                postalCode,
                country,
                dateOfBirth: dateOfBirth === undefined ? undefined : dateOfBirth,
                gender,
                occupation,
                companyName,
                aadharCardNumber,
                panCardNumber,
                fees,
                assignedTo: null,
                status,
                notes,
                organization: organizationId,
                createdBy: userId
            }
        });
    }

    if (clientLimitInfo && pendingClients.length > clientLimitInfo.remaining) {
        return next(new ErrorResponse(
            buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo),
            403
        ));
    }

    let createdCount = 0;
    for (const pending of pendingClients) {
        try {
            await Client.create(pending.doc);
            createdCount++;
        } catch (e) {
            errors.push({ row: pending.row, errors: formatMongooseErrorForUser(e) });
            skippedCount++;
        }
    }

    // Notify assignees when a non-assignee bulk-imports unassigned clients
    if (!importerIsAssignee && createdCount > 0) {
        try {
            const assigneeUserIds = await getAssigneeUserIdsForModule(organizationId, 'client');
            const creatorIdStr = userId.toString();
            const recipientIds = assigneeUserIds.filter((id) => id !== creatorIdStr);
            for (const assigneeId of recipientIds) {
                await Notification.create({
                    userId: assigneeId,
                    organization: organizationId,
                    type: 'client_bulk_imported',
                    title: 'Clients imported',
                    message: `${createdCount} client(s) were imported and are unassigned.`,
                    relatedEntityType: 'client',
                    relatedEntityId: null,
                    createdBy: creatorIdStr
                });
            }
        } catch (notifErr) {
            console.error('⚠️ Failed to create bulk-import notifications:', notifErr.message);
        }
    }

    res.status(200).json({
        success: true,
        message: 'Client Excel import completed',
        data: {
            created: createdCount,
            skipped: skippedCount,
            errors
        }
    });
});

/**
 * @desc    Preview client Excel import (no DB writes)
 * @route   POST /api/clients/excel/preview
 * @access  Private (Requires 'create' permission on 'client' module)
 */
exports.previewClientsExcelImport = asyncHandler(async (req, res, next) => {
    const organizationId = getOrganizationIdFromUser(req.user);
    const importerIsAssignee = req.userRole && canAssignModule(req.userRole, 'client');
    const subscriptionSummary = await getEffectiveSubscriptionSummaryForUser(req.user);
    const importRowLimit = getExcelImportRowLimit(subscriptionSummary?.subscriptionPlan);

    const file = req.file;
    if (!file || !file.buffer) {
        return next(new ErrorResponse('Excel file is required (form-data field: file)', 400));
    }

    const parsed = parseExcelFromBuffer(file.buffer, {
        sheetName: CLIENT_EXCEL_SHEET,
        expectedHeaders: CLIENT_EXCEL_HEADERS,
        maxRows: importRowLimit
    });

    if (!parsed.ok) {
        return next(new ErrorResponse(parsed.error, 400));
    }

    const preview = [];
    const errors = [];
    const currentClientCount = await Client.countDocuments({ organization: organizationId, deletedAt: null });
    const clientLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxClients', currentClientCount);

    for (const row of parsed.rows) {
        const r = row.rowNumber;
        const d = row.data;

        const firstName = toSafeString(d.firstName);
        const lastName = toSafeString(d.lastName);
        const email = toSafeString(d.email).toLowerCase() || undefined;
        const phoneRaw = toSafeString(d.phone);
        const phone = phoneRaw ? phoneRaw.replace(/\D/g, '') : '';
        const alternatePhoneRaw = toSafeString(d.alternatePhone);
        const alternatePhone = alternatePhoneRaw ? alternatePhoneRaw.replace(/\D/g, '') : '';
        const streetAddress = toSafeString(d.streetAddress);
        const city = toSafeString(d.city);
        const province = toSafeString(d.province);
        const postalCode = toSafeString(d.postalCode);
        const country = toSafeString(d.country) || 'India';
        const dateOfBirth = toOptionalDate(d.dateOfBirth);
        const gender = toSafeString(d.gender) || undefined;
        const occupation = toSafeString(d.occupation) || undefined;
        const companyName = toSafeString(d.companyName) || undefined;
        const aadharCardNumber = toSafeString(d.aadharCardNumber) || undefined;
        const panCardNumber = toSafeString(d.panCardNumber) || undefined;
        const fees = toOptionalNumber(d.fees);
        const status = toSafeString(d.status) || undefined;
        const notes = toSafeString(d.notes) || undefined;

        const rowIssues = [];
        if (!firstName) rowIssues.push('firstName is required');
        if (!lastName) rowIssues.push('lastName is required');
        if (!phone) rowIssues.push('phone is required');
        if (phone && phone.length !== 10) rowIssues.push('phone must be a 10-digit number');
        if (alternatePhone && alternatePhone.length !== 10) rowIssues.push('alternatePhone must be a 10-digit number');
        if (!streetAddress) rowIssues.push('streetAddress is required');
        if (!city) rowIssues.push('city is required');
        if (!province) rowIssues.push('province is required');
        if (!postalCode) rowIssues.push('postalCode is required');
        if (fees === undefined || Number.isNaN(fees)) rowIssues.push('fees is required and must be a number');
        if (dateOfBirth !== undefined && Number.isNaN(dateOfBirth)) rowIssues.push('dateOfBirth must be a valid date');
        if (gender && !CLIENT_GENDER_ENUM.includes(gender)) rowIssues.push(`gender must be one of: ${CLIENT_GENDER_ENUM.join(', ')}`);
        if (status && !CLIENT_STATUS_ENUM.includes(status)) rowIssues.push(`status must be one of: ${CLIENT_STATUS_ENUM.join(', ')}`);

        let willCreate = true;
        let duplicateReason = null;
        if (email) {
            const existingClient = await Client.findOne({
                organization: organizationId,
                email,
                deletedAt: null
            }).select('_id email').lean();
            if (existingClient) {
                willCreate = false;
                duplicateReason = 'email already exists';
                rowIssues.push('A client with this email already exists');
            }
        }

        if (rowIssues.length > 0) {
            errors.push({ row: r, errors: rowIssues });
        }

        preview.push({
            row: r,
            willCreate: willCreate && rowIssues.length === 0,
            issues: rowIssues,
            duplicateReason,
            data: {
                firstName,
                lastName,
                email: email || '',
                phone,
                alternatePhone: alternatePhone || '',
                streetAddress,
                city,
                province,
                postalCode,
                country,
                dateOfBirth: dateOfBirth && !Number.isNaN(dateOfBirth) ? new Date(dateOfBirth).toISOString().slice(0, 10) : '',
                gender: gender || '',
                occupation: occupation || '',
                companyName: companyName || '',
                aadharCardNumber: aadharCardNumber || '',
                panCardNumber: panCardNumber || '',
                fees: fees ?? '',
                assignedTo: '',
                status: status || '',
                notes: notes || ''
            },
            willNotifyAssignees: !importerIsAssignee
        });
    }

    const validRows = preview.filter((p) => p.willCreate).length;
    const clientLimitExceeded = Boolean(clientLimitInfo && validRows > clientLimitInfo.remaining);
    if (clientLimitExceeded) {
        errors.push({ row: null, errors: [buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo)] });
    }

    res.status(200).json({
        success: true,
        message: 'Client Excel preview generated',
        data: {
            rows: preview,
            totals: {
                totalRows: preview.length,
                validRows,
                invalidRows: preview.filter((p) => !p.willCreate).length
            },
            subscriptionLimit: clientLimitInfo ? {
                limitKey: 'maxClients',
                max: clientLimitInfo.max,
                used: clientLimitInfo.used,
                remaining: clientLimitInfo.remaining,
                requested: validRows,
                canImport: !clientLimitExceeded,
                message: clientLimitExceeded ? buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo) : null
            } : null,
            errors
        }
    });
});
