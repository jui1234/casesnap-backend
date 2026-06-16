// controllers/caseController.js
// Case CRUD operations with RBAC

const mongoose = require('mongoose');
const { generateClientId } = require('../utils/idGenerator');
const Case = require('../models/Case');
const Client = require('../models/Client');
const Notification = require('../models/Notification');
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const {
    canAssignModule,
    getAssigneeUserIdsForModule,
    assertAssignableUserInOrg
} = require('../utils/assigneeUtils');
const { sendEncryptedJson } = require('../utils/responseEncryption');
const { parseExcelFromBuffer, writeExcelToBuffer, toSafeString, toOptionalNumber, formatMongooseErrorForUser } = require('../utils/excelUtils');
const { getExcelImportRowLimit } = require('../utils/subscriptionFeatureUtils');
const { getOrganizationIdFromUser, getEffectiveSubscriptionSummaryForUser } = require('../utils/subscriptionContext');

const canViewAllCases = (userRole) => canAssignModule(userRole, 'cases');
const STAGE_CONFIRM_USER_SELECT = '_id firstName lastName email';

const MAX_BULK_ASSIGN_CASES = 2000;

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

function normalizeCaseIdList(rawIds) {
    return [...new Set((rawIds || []).map((id) => String(id ?? '').trim()).filter(Boolean))];
}

const normalizeOrganizationId = (org) => {
    if (!org) return null;
    if (typeof org === 'string') return org;
    if (org._id) return org._id.toString();
    if (org.toString) return org.toString();
    return null;
};

const sanitizeStagePayload = (payload = {}) => ({
    stageName: payload.stageName ? String(payload.stageName).trim() : '',
    todaySummary: payload.todaySummary ? String(payload.todaySummary).trim() : '',
    nextDate: payload.nextDate ? new Date(payload.nextDate) : null,
    nextDatePurpose: payload.nextDatePurpose ? String(payload.nextDatePurpose).trim() : '',
    nextDatePreparation: payload.nextDatePreparation ? String(payload.nextDatePreparation).trim() : '',
    confirmedBy: payload.confirmedBy ? String(payload.confirmedBy).trim() : ''
});

const isValidDateOrNull = (d) => d === null || (d instanceof Date && !Number.isNaN(d.getTime()));

const CASE_EXCEL_SHEET = 'Cases';
const CASE_COURT_PREMISES_ENUM = Case.schema?.path('courtPremises')?.enumValues || [];
// One row can represent one case-client link.
// Merge rows by caseNumber (trimmed) when provided; duplicate caseNumbers become one case with multiple clients.
// If caseNumber is merged vertically in Excel, only the first row may contain the value — following rows with
// empty caseNumber but client (or case-side) data still merge into that caseNumber when it appeared above.
// When caseNumber is empty: rows belong to one case if they share the same caseType+partyName anchor, or if they
// are continuation rows (client columns and/or notes, court, clientCount, etc.) before the next anchor — blank
// Excel rows are skipped, so a client on a later row still links to the same case.
// caseNumber and internal case _id are auto-generated when omitted.
// For client resolution, provide clientId OR clientPhone OR clientEmail. If none match and you want auto-create,
// provide required client creation fields.
const CASE_EXCEL_HEADERS_V2 = [
    'caseType',
    'partyName',
    'stage',
    'courtName',
    'courtPremises',
    'clientCount',
    'notes',
    'clientId',
    'clientPhone',
    'clientEmail',
    'clientFirstName',
    'clientLastName',
    'clientStreetAddress',
    'clientCity',
    'clientProvince',
    'clientPostalCode',
    'clientCountry',
    'clientFees'
];

// Template + export + preferred import layout: optional caseNumber first; empty => auto-generated caseNumber.
const CASE_EXCEL_HEADERS_V1 = ['caseNumber', ...CASE_EXCEL_HEADERS_V2];

// Older exports included caseId column; sheet still parses but caseId values are ignored (case _id is always auto-assigned).
const CASE_EXCEL_HEADERS_LEGACY_EXPORT_WITH_CASE_ID = ['caseId', 'caseNumber', ...CASE_EXCEL_HEADERS_V2];

function parseCaseExcel(buffer, { sheetName, maxRows } = {}) {
    const v1 = parseExcelFromBuffer(buffer, { sheetName, expectedHeaders: CASE_EXCEL_HEADERS_V1, maxRows });
    if (v1.ok) return { ...v1, version: 1 };

    const v2 = parseExcelFromBuffer(buffer, { sheetName, expectedHeaders: CASE_EXCEL_HEADERS_V2, maxRows });
    if (v2.ok) return { ...v2, version: 2 };

    const legacy = parseExcelFromBuffer(buffer, { sheetName, expectedHeaders: CASE_EXCEL_HEADERS_LEGACY_EXPORT_WITH_CASE_ID, maxRows });
    if (legacy.ok) return { ...legacy, version: 'legacy-export' };

    return v1; // preferred layout error message
}

/**
 * Same caseNumber can span multiple rows (one per client). Merged cells / templates often leave
 * caseType, partyName, etc. blank on continuation rows — only the first physical row has values.
 * Take the first non-empty value across the group so validation matches what users see in Excel.
 */
function firstNonEmptyCaseExcelField(rows, field) {
    for (const rr of rows) {
        const s = toSafeString(rr.data[field]).trim();
        if (s) return s;
    }
    return '';
}

function firstDefinedClientCountInCaseGroup(rows) {
    for (const rr of rows) {
        const n = toOptionalNumber(rr.data.clientCount);
        if (n !== undefined && !Number.isNaN(n)) return n;
    }
    return undefined;
}

/** Stable key when both case type and party name are present (used to merge repeated header rows). */
function caseExcelImplicitAnchorKey(d) {
    const t = toSafeString(d.caseType).trim().toLowerCase();
    const p = toSafeString(d.partyName).trim().toLowerCase();
    if (!t || !p) return null;
    return `${t}\0${p}`;
}

function caseExcelRowHasClientPayload(d) {
    return !!(
        toSafeString(d.clientId) ||
        toSafeString(d.clientPhone) ||
        toSafeString(d.clientEmail) ||
        toSafeString(d.clientFirstName) ||
        toSafeString(d.clientLastName)
    );
}

function caseExcelRowHasContinuationFields(d) {
    return !!(
        toSafeString(d.stage) ||
        toSafeString(d.courtName) ||
        toSafeString(d.courtPremises) ||
        toSafeString(d.notes) ||
        toOptionalNumber(d.clientCount) !== undefined
    );
}

/**
 * Build import groups in sheet order.
 * - Rows with the same caseNumber (trimmed) merge. Continuation rows often leave caseNumber blank after a merged
 *   cell in Excel — those attach to the most recent row that had a caseNumber if they carry client/continuation data.
 * - Without caseNumber: implicit groups use caseType+partyName anchor plus continuation rows as before.
 */
function buildCaseExcelImportGroups(parsedRows) {
    const groups = new Map();
    let implicitGroupKey = null;
    let implicitAnchorKey = null;
    /** Most recent physical row's caseNumber; continuation rows with empty caseNumber merge here. */
    let lastExplicitCaseNumber = null;

    for (const row of parsedRows) {
        const d = row.data;
        const r = row.rowNumber;
        const cn = toSafeString(d.caseNumber).trim();

        if (cn) {
            implicitGroupKey = null;
            implicitAnchorKey = null;
            lastExplicitCaseNumber = cn;
            if (!groups.has(cn)) groups.set(cn, []);
            groups.get(cn).push(row);
            continue;
        }

        const anchorKey = caseExcelImplicitAnchorKey(d);

        if (anchorKey) {
            lastExplicitCaseNumber = null;
            if (implicitGroupKey && implicitAnchorKey === anchorKey) {
                groups.get(implicitGroupKey).push(row);
            } else {
                implicitAnchorKey = anchorKey;
                implicitGroupKey = `__implicit_${r}`;
                groups.set(implicitGroupKey, [row]);
            }
            continue;
        }

        if (
            lastExplicitCaseNumber &&
            (caseExcelRowHasClientPayload(d) || caseExcelRowHasContinuationFields(d))
        ) {
            groups.get(lastExplicitCaseNumber).push(row);
            continue;
        }

        if (implicitGroupKey && (caseExcelRowHasClientPayload(d) || caseExcelRowHasContinuationFields(d))) {
            groups.get(implicitGroupKey).push(row);
            continue;
        }

        implicitGroupKey = null;
        implicitAnchorKey = null;
        lastExplicitCaseNumber = null;
        const orphanKey = `__row_${r}`;
        groups.set(orphanKey, [row]);
    }

    return groups;
}

function isStrictObjectIdString(id) {
    return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

/** Collect distinct keys from parsed Excel rows for batched DB lookups (preview + import). */
function collectCaseExcelLookupKeys(parsedRows) {
    const caseNumbers = new Set();
    const clientIdStrings = new Set();
    const phones = new Set();
    const emails = new Set();

    for (const row of parsedRows) {
        const d = row.data;
        const cn = toSafeString(d.caseNumber).trim();
        if (cn) caseNumbers.add(cn);

        const cid = toSafeString(d.clientId);
        if (cid) clientIdStrings.add(cid);

        const clientPhoneRaw = toSafeString(d.clientPhone);
        const clientPhone = clientPhoneRaw ? clientPhoneRaw.replace(/\D/g, '') : '';
        const clientEmail = toSafeString(d.clientEmail).toLowerCase();
        if (clientPhone) phones.add(clientPhone);
        if (clientEmail) emails.add(clientEmail);
    }

    return { caseNumbers, clientIdStrings, phones, emails };
}

/**
 * Load existing cases/clients referenced by the sheet in a few queries (avoids N+1 per row).
 * Import should call `addCreatedClientToCaseExcelLookups` after each Client.create so later rows resolve.
 */
async function loadCaseExcelImportLookups(organizationId, parsedRows) {
    const { caseNumbers, clientIdStrings, phones, emails } = collectCaseExcelLookupKeys(parsedRows);

    const existingCaseNumbers = new Set();
    const clientById = new Map();
    const clientsByPhone = new Map();
    const clientsByEmail = new Map();

    const caseNumArr = [...caseNumbers];
    const phoneArr = [...phones];
    const emailArr = [...emails];

    const objectIds = [];
    for (const s of clientIdStrings) {
        if (isStrictObjectIdString(s)) objectIds.push(new mongoose.Types.ObjectId(s));
    }

    const orConds = [];
    if (phoneArr.length) orConds.push({ phone: { $in: phoneArr } });
    if (emailArr.length) orConds.push({ email: { $in: emailArr } });

    const [caseDocs, clientByIdDocs, phoneEmailClients] = await Promise.all([
        caseNumArr.length
            ? Case.find({
                organization: organizationId,
                deletedAt: null,
                caseNumber: { $in: caseNumArr }
            })
                .select('_id caseNumber')
                .lean()
            : Promise.resolve([]),
        objectIds.length
            ? Client.find({
                _id: { $in: objectIds },
                organization: organizationId,
                deletedAt: null
            })
                .select('_id')
                .lean()
            : Promise.resolve([]),
        orConds.length
            ? Client.find({
                organization: organizationId,
                deletedAt: null,
                $or: orConds
            })
                .select('_id phone email')
                .lean()
            : Promise.resolve([])
    ]);

    for (const c of caseDocs) {
        if (c.caseNumber != null && String(c.caseNumber).trim()) existingCaseNumbers.add(String(c.caseNumber).trim());
    }
    for (const cl of clientByIdDocs) {
        clientById.set(cl._id.toString(), cl);
    }
    for (const cl of phoneEmailClients) {
        if (cl.phone != null && cl.phone !== '') {
            const key = String(cl.phone).replace(/\D/g, '');
            if (key) {
                if (!clientsByPhone.has(key)) clientsByPhone.set(key, []);
                clientsByPhone.get(key).push(cl);
            }
        }
        if (cl.email != null && String(cl.email).trim()) {
            const em = String(cl.email).toLowerCase();
            if (!clientsByEmail.has(em)) clientsByEmail.set(em, []);
            clientsByEmail.get(em).push(cl);
        }
    }

    return { existingCaseNumbers, clientById, clientsByPhone, clientsByEmail };
}

function addCreatedClientToCaseExcelLookups(lookups, doc) {
    const id = doc._id.toString();
    lookups.clientById.set(id, { _id: doc._id });
    if (doc.phone != null && doc.phone !== '') {
        const key = String(doc.phone).replace(/\D/g, '');
        if (key) {
            if (!lookups.clientsByPhone.has(key)) lookups.clientsByPhone.set(key, []);
            lookups.clientsByPhone.get(key).push({ _id: doc._id });
        }
    }
    if (doc.email != null && String(doc.email).trim()) {
        const em = String(doc.email).toLowerCase();
        if (!lookups.clientsByEmail.has(em)) lookups.clientsByEmail.set(em, []);
        lookups.clientsByEmail.get(em).push({ _id: doc._id });
    }
}

/** Undo addCreatedClientToCaseExcelLookups when a case group is skipped after staging new clients. */
function removePendingClientFromCaseExcelLookups(lookups, doc) {
    const idStr = doc._id.toString();
    lookups.clientById.delete(idStr);
    if (doc.phone != null && doc.phone !== '') {
        const key = String(doc.phone).replace(/\D/g, '');
        if (key && lookups.clientsByPhone.has(key)) {
            const arr = lookups.clientsByPhone.get(key).filter((c) => c._id.toString() !== idStr);
            if (arr.length) lookups.clientsByPhone.set(key, arr);
            else lookups.clientsByPhone.delete(key);
        }
    }
    if (doc.email != null && String(doc.email).trim()) {
        const em = String(doc.email).toLowerCase();
        if (lookups.clientsByEmail.has(em)) {
            const arr = lookups.clientsByEmail.get(em).filter((c) => c._id.toString() !== idStr);
            if (arr.length) lookups.clientsByEmail.set(em, arr);
            else lookups.clientsByEmail.delete(em);
        }
    }
}

/** Match clientId or phone/email against preloaded maps (same rules as former per-row queries). */
function resolveCaseExcelClientFromLookups(d, lookups) {
    const clientId = toSafeString(d.clientId);
    const clientPhoneRaw = toSafeString(d.clientPhone);
    const clientPhone = clientPhoneRaw ? clientPhoneRaw.replace(/\D/g, '') : '';
    const clientEmail = toSafeString(d.clientEmail).toLowerCase();
    const clientIssues = [];

    if (clientId) {
        const cl = lookups.clientById.get(clientId);
        if (!cl) {
            clientIssues.push(`clientId "${clientId}" not found in your organization`);
            return { clientPhone, clientPhoneRaw, clientEmail, linkedClientId: null, clientIssues };
        }
        return { clientPhone, clientPhoneRaw, clientEmail, linkedClientId: cl._id.toString(), clientIssues };
    }

    let byPhone = [];
    let byEmail = [];
    if (clientPhone) byPhone = lookups.clientsByPhone.get(clientPhone) || [];
    if (clientEmail) byEmail = lookups.clientsByEmail.get(clientEmail) || [];

    if (byPhone.length > 1) {
        clientIssues.push(`clientPhone "${clientPhoneRaw}" matches multiple clients. Please fix duplicates or use clientId.`);
    }
    if (byEmail.length > 1) {
        clientIssues.push(`clientEmail "${clientEmail}" matches multiple clients. Please fix duplicates or use clientId.`);
    }

    const phoneId = byPhone[0]?._id?.toString();
    const emailId = byEmail[0]?._id?.toString();
    if (phoneId && emailId && phoneId !== emailId) {
        clientIssues.push('clientPhone and clientEmail belong to different clients. Please correct or use clientId.');
    }

    const linkedClientId = !clientIssues.length ? phoneId || emailId || null : null;
    return { clientPhone, clientPhoneRaw, clientEmail, linkedClientId, clientIssues };
}

/**
 * @desc    Create a new case
 * @route   POST /api/cases
 * @access  Private (Requires 'create' permission on 'cases' module)
 */
exports.createCase = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const {
        caseNumber,
        caseType,
        partyName,
        courtName,
        courtPremises,
        assignedTo,
        clientCount = 0,
        clients: clientsInput = [],
        notes
    } = req.body;

    // Validate required fields
    if (!caseType || !partyName) {
        return next(new ErrorResponse('Case type and party name are required', 400));
    }

    const clientCountNum = parseInt(clientCount, 10) || 0;
    const clientsArr = Array.isArray(clientsInput) ? clientsInput : (clientsInput ? [clientsInput] : []);

    // Only assignees can assign cases to others or link clients
    const canAssign = req.userRole && canAssignModule(req.userRole, 'cases');
    if (!canAssign && (assignedTo || clientsArr.length > 0)) {
        return next(new ErrorResponse('Only users with case assignee permission can assign cases or link clients', 403));
    }

    if (clientsArr.length > clientCountNum) {
        return next(new ErrorResponse(`Cannot assign more than ${clientCountNum} client(s). clientCount is ${clientCountNum}.`, 400));
    }

    // Validate clients exist, belong to org, and are not deleted
    if (clientsArr.length > 0) {
        const validClients = await Client.find({
            _id: { $in: clientsArr },
            organization: organizationId,
            deletedAt: null
        }).select('_id').lean();
        const validIds = new Set(validClients.map((c) => c._id.toString()));
        const invalidIds = clientsArr.filter((id) => !validIds.has(String(id)));
        if (invalidIds.length > 0) {
            return next(new ErrorResponse(`Invalid or inaccessible client(s): ${invalidIds.join(', ')}`, 400));
        }
    }

    // Check if case with same case number exists in organization (only if provided)
    const effectiveCaseNumber = typeof caseNumber === 'string' ? caseNumber.trim() : '';
    if (effectiveCaseNumber) {
        const existingCase = await Case.findOne({
            organization: organizationId,
            caseNumber: effectiveCaseNumber,
            deletedAt: null
        });

        if (existingCase) {
            return next(new ErrorResponse('A case with this case number already exists in your organization', 400));
        }
    }

    // Do not auto-assign to creator.
    let effectiveAssignedTo = null;
    if (assignedTo !== undefined && assignedTo !== null && String(assignedTo).trim() !== '') {
        effectiveAssignedTo = assignedTo;
        if (String(effectiveAssignedTo) !== String(userId) && req.userRole && !canAssignModule(req.userRole, 'cases')) {
            return next(new ErrorResponse('You do not have permission to assign cases to other users', 403));
        }
        const assigneeCheck = await assertAssignableUserInOrg(organizationId, effectiveAssignedTo);
        if (assigneeCheck && assigneeCheck.error) {
            return next(new ErrorResponse(assigneeCheck.error, 400));
        }
    }

    const newCase = await Case.create({
        ...(effectiveCaseNumber ? { caseNumber: effectiveCaseNumber } : {}),
        caseType: caseType.trim(),
        partyName: partyName.trim(),
        courtName: courtName ? courtName.trim() : undefined,
        courtPremises: courtPremises || undefined,
        assignedTo: effectiveAssignedTo,
        clientCount: clientCountNum,
        clients: clientsArr,
        organization: organizationId,
        createdBy: userId,
        notes: notes ? notes.trim() : undefined
    });

    console.log('✅ Case created:', {
        id: newCase._id,
        caseNumber: newCase.caseNumber,
        partyName: newCase.partyName,
        organization: organizationId
    });

    // When creator does NOT have assignee permission, notify assignees
    const creatorHasAssignee = req.userRole && canAssignModule(req.userRole, 'cases');
    if (!creatorHasAssignee) {
        try {
            const assigneeUserIds = await getAssigneeUserIdsForModule(organizationId, 'cases');
            const creatorIdStr = userId.toString();
            const recipientIds = assigneeUserIds.filter((id) => id !== creatorIdStr);
            const caseLabel = newCase.caseNumber || 'New case';
            for (const assigneeId of recipientIds) {
                await Notification.create({
                    userId: assigneeId,
                    organization: organizationId,
                    type: 'case_created',
                    title: 'New case created',
                    message: `${caseLabel} (${newCase.partyName}) was created and may need to be assigned.`,
                    relatedEntityType: 'case',
                    relatedEntityId: newCase._id.toString(),
                    createdBy: creatorIdStr
                });
            }
            if (recipientIds.length > 0) {
                console.log('📬 Notified', recipientIds.length, 'assignee(s) of new case');
            }
        } catch (notifErr) {
            console.error('⚠️ Failed to create assignee notifications:', notifErr.message);
        }
    }

    // Notify the assigned user when creator assigns to someone else during creation
    if (effectiveAssignedTo && String(effectiveAssignedTo) !== userId.toString()) {
        try {
            const caseLabel = newCase.caseNumber || 'New case';
            await Notification.create({
                userId: String(effectiveAssignedTo),
                organization: organizationId,
                type: 'case_assigned',
                title: 'Case assigned to you',
                message: `${caseLabel} (${newCase.partyName}) has been assigned to you.`,
                relatedEntityType: 'case',
                relatedEntityId: newCase._id.toString(),
                createdBy: userId.toString()
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create case_assigned notification:', notifErr.message);
        }
    }

    await newCase.populate('assignedTo', 'firstName lastName email');
    await newCase.populate('createdBy', 'firstName lastName email');
    await newCase.populate('clients', 'firstName lastName email phone');
    await newCase.populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    res.status(201).json({
        success: true,
        message: 'Case created successfully',
        data: newCase
    });
});

/**
 * @desc    Bulk assign cases to user(s) (or unassign). SUPER_ADMIN or cases-module assignees only.
 * @route   POST /api/cases/bulk-assign
 * @access  Private — `cases` read + cases assignee (see rbac.requireCaseBulkAssignAccess)
 * @body    Mode A — one assignee for many cases:
 *          { caseIds: string[], assignedTo?: string | null }
 *          Mode B — many assignees in one request (each group: many cases → one user):
 *          { groups: Array<{ caseIds: string[], assignedTo?: string | null }> }
 *          Use `assignedTo: null` or omit to clear assignment for that group. Each case may appear in only one group.
 */
exports.bulkAssignCases = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;
    const updatedByStr = userId && userId.toString ? userId.toString() : String(userId);

    const { caseIds, assignedTo, groups } = req.body;
    const useGroups = Array.isArray(groups) && groups.length > 0;

    if (useGroups) {
        const seenCases = new Set();
        const normalizedGroups = [];

        for (let i = 0; i < groups.length; i++) {
            const g = groups[i] || {};
            const ids = normalizeCaseIdList(g.caseIds);
            if (ids.length === 0) {
                return next(new ErrorResponse(`groups[${i}].caseIds must contain at least one case ID`, 400));
            }
            for (const id of ids) {
                if (seenCases.has(id)) {
                    return next(
                        new ErrorResponse(
                            `Each case can only appear once across groups (duplicate: ${id})`,
                            400
                        )
                    );
                }
                seenCases.add(id);
            }
            normalizedGroups.push({ caseIds: ids, assignedTo: g.assignedTo });
        }

        if (seenCases.size > MAX_BULK_ASSIGN_CASES) {
            return next(new ErrorResponse(`At most ${MAX_BULK_ASSIGN_CASES} distinct cases per request`, 400));
        }

        const assigneeIdsToCheck = new Set();
        for (const g of normalizedGroups) {
            if (g.assignedTo !== undefined && g.assignedTo !== null && String(g.assignedTo).trim() !== '') {
                assigneeIdsToCheck.add(String(g.assignedTo).trim());
            }
        }

        for (const aid of assigneeIdsToCheck) {
            const check = await assertAssignableUserInOrg(organizationId, aid);
            if (check && check.error) return next(new ErrorResponse(`${check.error} (userId: ${aid})`, 400));
        }

        const groupResults = [];
        let totalRequested = 0;
        let totalMatched = 0;
        let totalModified = 0;

        for (let i = 0; i < normalizedGroups.length; i++) {
            const { caseIds: gIds, assignedTo: gAssign } = normalizedGroups[i];
            totalRequested += gIds.length;

            let targetAssignedTo = null;
            if (gAssign !== undefined && gAssign !== null && String(gAssign).trim() !== '') {
                targetAssignedTo = String(gAssign).trim();
            }

            const existing = await Case.find({
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
                const updateResult = await Case.updateMany(
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
                        type: 'case_assigned',
                        title: 'Cases assigned to you',
                        message: `${modifiedCount} case(s) have been assigned to you.`,
                        relatedEntityType: 'case',
                        relatedEntityId: null,
                        createdBy: updatedByStr
                    });
                } catch (notifErr) {
                    console.error('⚠️ Failed to create case_assigned notification:', notifErr.message);
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

    if (!Array.isArray(caseIds) || caseIds.length === 0) {
        return next(
            new ErrorResponse(
                'Send either { caseIds, assignedTo } for one assignee, or { groups: [{ caseIds, assignedTo }, ...] } for multiple assignees',
                400
            )
        );
    }
    if (caseIds.length > MAX_BULK_ASSIGN_CASES) {
        return next(new ErrorResponse(`At most ${MAX_BULK_ASSIGN_CASES} cases per request`, 400));
    }

    const uniqueIds = normalizeCaseIdList(caseIds);
    if (uniqueIds.length === 0) {
        return next(new ErrorResponse('caseIds must contain at least one valid case ID', 400));
    }

    const assigneeCheck = await assertAssignableUserInOrg(organizationId, assignedTo);
    if (assigneeCheck && assigneeCheck.error) {
        return next(new ErrorResponse(assigneeCheck.error, 400));
    }
    const targetAssignedTo = assigneeCheck ? assigneeCheck.assignedTo : null;

    const existing = await Case.find({
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
            message: 'No matching cases updated',
            data: {
                mode: 'single',
                requested: uniqueIds.length,
                matched: 0,
                modified: 0,
                missingIds: uniqueIds.slice(0, 100)
            }
        });
    }

    const updateResult = await Case.updateMany(
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
                type: 'case_assigned',
                title: 'Cases assigned to you',
                message: `${modifiedCount} case(s) have been assigned to you.`,
                relatedEntityType: 'case',
                relatedEntityId: null,
                createdBy: updatedByStr
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create case_assigned notification:', notifErr.message);
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
 * @desc    Get all cases with pagination and filters
 * @route   GET /api/cases
 * @access  Private (Requires 'read' permission on 'cases' module)
 */
exports.getCases = asyncHandler(async (req, res, next) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;
    const {
        page = 1,
        limit = 10,
        status,
        assignedTo,
        assignmentFilter,
        search,
        caseType,
        caseNumber,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        includeDeleted = false
    } = req.query;

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

    if (caseType && String(caseType).trim()) {
        query.caseType = { $regex: caseType.trim(), $options: 'i' };
    }

    if (caseNumber && String(caseNumber).trim()) {
        query.caseNumber = { $regex: caseNumber.trim(), $options: 'i' };
    }

    if (!canViewAllCases(req.userRole)) {
        query.assignedTo = userId;
    }

    if (search) {
        query.$or = [
            { caseNumber: { $regex: search, $options: 'i' } },
            { caseType: { $regex: search, $options: 'i' } },
            { partyName: { $regex: search, $options: 'i' } },
            { 'stages.stageName': { $regex: search, $options: 'i' } },
            { courtName: { $regex: search, $options: 'i' } }
        ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const findOptions = showDeleted ? { includeDeleted: true } : {};
    const findQuery = Case.find(query).setOptions(findOptions);
    const countQuery = Case.countDocuments(query).setOptions(findOptions);

    const cases = await findQuery
        .populate('assignedTo', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .populate('clients', 'firstName lastName email phone')
        .populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT)
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();

    const total = await countQuery;

    sendEncryptedJson(res, 200, {
        success: true,
        count: cases.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        data: cases
    });
});

/**
 * @desc    Get single case by ID
 * @route   GET /api/cases/:id
 * @access  Private (Requires 'read' permission on 'cases' module)
 */
exports.getCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    })
        .populate('assignedTo', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .populate('updatedBy', 'firstName lastName email')
        .populate('clients', 'firstName lastName email phone')
        .populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo?._id || caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to view this case', 403));
    }

    const data = caseDoc.toObject ? caseDoc.toObject() : caseDoc;

    sendEncryptedJson(res, 200, { success: true, data });
});

/**
 * @desc    Update case
 * @route   PUT /api/cases/:id
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.updateCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    let caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to update this case', 403));
    }

    if (req.body.caseNumber !== undefined && req.body.caseNumber.trim() !== caseDoc.caseNumber) {
        const existingCase = await Case.findOne({
            organization: organizationId,
            caseNumber: req.body.caseNumber.trim(),
            _id: { $ne: id },
            deletedAt: null
        });
        if (existingCase) {
            return next(new ErrorResponse('A case with this case number already exists', 400));
        }
    }

    if (req.body.assignedTo !== undefined && String(req.body.assignedTo) !== String(caseDoc.assignedTo)) {
        if (!req.userRole || !canAssignModule(req.userRole, 'cases')) {
            return next(new ErrorResponse('You do not have permission to assign cases to other users', 403));
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

    // clientCount and clients - only assignees can update
    if (req.body.clientCount !== undefined || req.body.clients !== undefined) {
        if (!req.userRole || !canAssignModule(req.userRole, 'cases')) {
            return next(new ErrorResponse('Only users with case assignee permission can link clients to cases', 403));
        }
        const newClientCount = req.body.clientCount !== undefined
            ? (parseInt(req.body.clientCount, 10) || 0)
            : (caseDoc.clientCount || 0);
        const newClients = req.body.clients !== undefined
            ? (Array.isArray(req.body.clients) ? req.body.clients : [req.body.clients].filter(Boolean))
            : (caseDoc.clients || []).map((c) => (typeof c === 'object' ? c._id : c).toString());
        if (newClients.length > newClientCount) {
            return next(new ErrorResponse(`Cannot assign more than ${newClientCount} client(s). clientCount is ${newClientCount}.`, 400));
        }
        const validClients = await Client.find({
            _id: { $in: newClients },
            organization: organizationId,
            deletedAt: null
        }).select('_id').lean();
        const validIds = new Set(validClients.map((c) => c._id.toString()));
        const invalidIds = newClients.filter((id) => !validIds.has(String(id)));
        if (invalidIds.length > 0) {
            return next(new ErrorResponse(`Invalid or inaccessible client(s): ${invalidIds.join(', ')}`, 400));
        }
        caseDoc.clientCount = newClientCount;
        caseDoc.clients = newClients;
    }

    const previousAssignedTo = caseDoc.assignedTo ? String(caseDoc.assignedTo) : null;

    const updateFields = [
        'caseNumber', 'caseType', 'partyName', 'courtName', 'courtPremises',
        'assignedTo', 'status', 'notes'
    ];

    updateFields.forEach(field => {
        if (req.body[field] !== undefined) {
            const val = req.body[field];
            caseDoc[field] = typeof val === 'string' ? val.trim() : val;
        }
    });

    caseDoc.updatedBy = userId;
    await caseDoc.save();

    // Notify new assignee when assignment changes to a different user
    const newAssignedTo = caseDoc.assignedTo ? String(caseDoc.assignedTo) : null;
    const updaterIdStr = userId.toString();
    if (req.body.assignedTo !== undefined && newAssignedTo && newAssignedTo !== previousAssignedTo && newAssignedTo !== updaterIdStr) {
        try {
            const caseLabel = caseDoc.caseNumber || String(caseDoc._id);
            await Notification.create({
                userId: newAssignedTo,
                organization: organizationId,
                type: 'case_assigned',
                title: 'Case assigned to you',
                message: `${caseLabel} (${caseDoc.partyName}) has been assigned to you.`,
                relatedEntityType: 'case',
                relatedEntityId: caseDoc._id.toString(),
                createdBy: updaterIdStr
            });
        } catch (notifErr) {
            console.error('⚠️ Failed to create case_assigned notification:', notifErr.message);
        }
    }

    await caseDoc.populate('assignedTo', 'firstName lastName email');
    await caseDoc.populate('createdBy', 'firstName lastName email');
    await caseDoc.populate('updatedBy', 'firstName lastName email');
    await caseDoc.populate('clients', 'firstName lastName email phone');
    await caseDoc.populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    console.log('✅ Case updated:', { id: caseDoc._id, caseNumber: caseDoc.caseNumber });

    res.status(200).json({
        success: true,
        message: 'Case updated successfully',
        data: caseDoc
    });
});

/**
 * @desc    Delete case (soft delete)
 * @route   DELETE /api/cases/:id
 * @access  Private (Requires 'delete' permission on 'cases' module)
 */
exports.deleteCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to delete this case', 403));
    }

    caseDoc.deletedAt = new Date();
    caseDoc.deletedBy = userId;
    caseDoc.status = 'inactive';
    await caseDoc.save();

    console.log('✅ Case deleted:', { id: caseDoc._id, caseNumber: caseDoc.caseNumber });

    res.status(200).json({
        success: true,
        message: 'Case deleted successfully'
    });
});

/**
 * @desc    Restore deleted case
 * @route   PUT /api/cases/:id/restore
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.restoreCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: { $ne: null }
    }).setOptions({ includeDeleted: true });

    if (!caseDoc) {
        return next(new ErrorResponse('Deleted case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to restore this case', 403));
    }

    caseDoc.deletedAt = null;
    caseDoc.deletedBy = null;
    caseDoc.status = 'active';
    await caseDoc.save();

    res.status(200).json({
        success: true,
        message: 'Case restored successfully',
        data: caseDoc
    });
});

/**
 * @desc    Archive case
 * @route   PUT /api/cases/:id/archive
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.archiveCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to archive this case', 403));
    }

    caseDoc.status = 'archived';
    await caseDoc.save();

    res.status(200).json({
        success: true,
        message: 'Case archived successfully',
        data: caseDoc
    });
});

/**
 * @desc    Unarchive case
 * @route   PUT /api/cases/:id/unarchive
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.unarchiveCase = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== String(userId)) {
        return next(new ErrorResponse('You do not have permission to unarchive this case', 403));
    }

    caseDoc.status = 'active';
    await caseDoc.save();

    res.status(200).json({
        success: true,
        message: 'Case unarchived successfully',
        data: caseDoc
    });
});

/**
 * @desc    Download case Excel template (strict headers)
 * @route   GET /api/cases/excel/template
 * @access  Private (Requires 'read' permission on 'cases' module)
 */
exports.downloadCaseExcelTemplate = asyncHandler(async (req, res) => {
    const buffer = writeExcelToBuffer({
        sheetName: CASE_EXCEL_SHEET,
        headers: CASE_EXCEL_HEADERS_V1,
        rows: []
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cases-template.xlsx"');
    res.status(200).send(buffer);
});

/**
 * @desc    Export cases to Excel
 * @route   GET /api/cases/excel/export
 * @access  Private (Requires 'read' permission on 'cases' module)
 */
exports.exportCasesToExcel = asyncHandler(async (req, res) => {
    const organizationId = req.user.organization;
    const userId = req.user._id;

    const {
        status,
        assignedTo,
        assignmentFilter,
        search,
        caseType,
        caseNumber,
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
    if (caseType && String(caseType).trim()) query.caseType = { $regex: String(caseType).trim(), $options: 'i' };
    if (caseNumber && String(caseNumber).trim()) query.caseNumber = { $regex: String(caseNumber).trim(), $options: 'i' };
    if (search) {
        query.$or = [
            { caseNumber: { $regex: search, $options: 'i' } },
            { caseType: { $regex: search, $options: 'i' } },
            { partyName: { $regex: search, $options: 'i' } },
            { stage: { $regex: search, $options: 'i' } },
            { courtName: { $regex: search, $options: 'i' } }
        ];
    }

    if (!canViewAllCases(req.userRole)) {
        query.assignedTo = userId;
    }

    const findOptions = showDeleted ? { includeDeleted: true } : {};
    const cases = await Case.find(query)
        .setOptions(findOptions)
        .populate('clients', 'firstName lastName email phone streetAddress city province postalCode country fees')
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .lean();

    // Flatten: one row per case-client (or one row with empty client fields if no clients)
    const rows = [];
    for (const c of cases) {
        const clients = Array.isArray(c.clients) ? c.clients : [];
        if (clients.length === 0) {
            rows.push({
                caseNumber: c.caseNumber ?? '',
                caseType: c.caseType ?? '',
                partyName: c.partyName ?? '',
                stage: c.stage ?? '',
                courtName: c.courtName ?? '',
                courtPremises: c.courtPremises ?? '',
                clientCount: c.clientCount ?? 0,
                notes: c.notes ?? '',
                clientId: '',
                clientPhone: '',
                clientEmail: '',
                clientFirstName: '',
                clientLastName: '',
                clientStreetAddress: '',
                clientCity: '',
                clientProvince: '',
                clientPostalCode: '',
                clientCountry: '',
                clientFees: ''
            });
            continue;
        }
        for (const cl of clients) {
            rows.push({
                caseNumber: c.caseNumber ?? '',
                caseType: c.caseType ?? '',
                partyName: c.partyName ?? '',
                stage: c.stage ?? '',
                courtName: c.courtName ?? '',
                courtPremises: c.courtPremises ?? '',
                clientCount: c.clientCount ?? clients.length,
                notes: c.notes ?? '',
                clientId: cl?._id ?? '',
                clientPhone: cl?.phone ?? '',
                clientEmail: cl?.email ?? '',
                clientFirstName: cl?.firstName ?? '',
                clientLastName: cl?.lastName ?? '',
                clientStreetAddress: cl?.streetAddress ?? '',
                clientCity: cl?.city ?? '',
                clientProvince: cl?.province ?? '',
                clientPostalCode: cl?.postalCode ?? '',
                clientCountry: cl?.country ?? '',
                clientFees: cl?.fees ?? ''
            });
        }
    }

    const buffer = writeExcelToBuffer({
        sheetName: CASE_EXCEL_SHEET,
        headers: CASE_EXCEL_HEADERS_V1,
        rows
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cases-export.xlsx"');
    res.status(200).send(buffer);
});

/**
 * @desc    Import cases from Excel (strict template). Auto-creates clients if missing.
 * @route   POST /api/cases/excel/import
 * @access  Private (Requires 'create' permission on 'cases' module)
 */
exports.importCasesFromExcel = asyncHandler(async (req, res, next) => {
    const organizationId = getOrganizationIdFromUser(req.user);
    const userId = req.user._id;
    const subscriptionSummary = await getEffectiveSubscriptionSummaryForUser(req.user);
    const importRowLimit = getExcelImportRowLimit(subscriptionSummary?.subscriptionPlan);

    const file = req.file;
    if (!file || !file.buffer) {
        return next(new ErrorResponse('Excel file is required (form-data field: file)', 400));
    }

    const parsed = parseCaseExcel(file.buffer, { sheetName: CASE_EXCEL_SHEET, maxRows: importRowLimit });
    if (!parsed.ok) return next(new ErrorResponse(parsed.error, 400));

    const canAssign = req.userRole && canAssignModule(req.userRole, 'cases');
    const importerIsAssignee = !!canAssign;

    const groups = buildCaseExcelImportGroups(parsed.rows);
    const errors = [];

    const lookups = await loadCaseExcelImportLookups(organizationId, parsed.rows);

    const pendingNewClients = [];
    const pendingNewCases = [];
    let linkedExistingClients = 0;
    let skippedCases = 0;
    const createdByStr = userId && userId.toString ? userId.toString() : String(userId);

    for (const [caseKey, rows] of groups.entries()) {
        const first = rows[0];
        const groupPendingClients = [];
        const rowIssues = [];

        const caseNumber = firstNonEmptyCaseExcelField(rows, 'caseNumber');
        const caseType = firstNonEmptyCaseExcelField(rows, 'caseType');
        const partyName = firstNonEmptyCaseExcelField(rows, 'partyName');
        const stageRaw = firstNonEmptyCaseExcelField(rows, 'stage');
        const stage = stageRaw || undefined;
        const courtNameRaw = firstNonEmptyCaseExcelField(rows, 'courtName');
        const courtName = courtNameRaw || undefined;
        const courtPremisesRaw = firstNonEmptyCaseExcelField(rows, 'courtPremises');
        const courtPremises = courtPremisesRaw || undefined;
        const notesRaw = firstNonEmptyCaseExcelField(rows, 'notes');
        const notes = notesRaw || undefined;
        const clientCount = firstDefinedClientCountInCaseGroup(rows);

        if (!caseType) rowIssues.push('caseType is required');
        if (!partyName) rowIssues.push('partyName is required');
        if (courtPremises && CASE_COURT_PREMISES_ENUM.length > 0 && !CASE_COURT_PREMISES_ENUM.includes(courtPremises)) {
            rowIssues.push(`courtPremises must be one of: ${CASE_COURT_PREMISES_ENUM.join(', ')}`);
        }

        const anyClientFields = rows.some((rr) =>
            toSafeString(rr.data.clientId) ||
            toSafeString(rr.data.clientPhone) ||
            toSafeString(rr.data.clientEmail) ||
            toSafeString(rr.data.clientFirstName) ||
            toSafeString(rr.data.clientLastName)
        );
        if (!canAssign && anyClientFields) {
            rowIssues.push('Only users with case assignee permission can link/create clients during import');
        }

        if (caseNumber && lookups.existingCaseNumbers.has(caseNumber)) {
            rowIssues.push('A case with this caseNumber already exists');
        }

        const caseErrCtx = { ...(caseNumber ? { caseNumber } : {}) };

        if (rowIssues.length > 0) {
            errors.push({ row: first.rowNumber, ...caseErrCtx, errors: rowIssues });
            skippedCases++;
            continue;
        }

        const clientIds = [];
        const clientIdSeen = new Set();

        for (const rr of rows) {
            const r = rr.rowNumber;
            const d = rr.data;

            const clientId = toSafeString(d.clientId);
            const match = resolveCaseExcelClientFromLookups(d, lookups);
            const { clientPhone, clientPhoneRaw, clientEmail, linkedClientId: fromLookup, clientIssues: matchIssues } = match;

            let resolvedClientId = null;

            if (clientId) {
                if (matchIssues.length) {
                    errors.push({ row: r, ...caseErrCtx, errors: matchIssues });
                    continue;
                }
                resolvedClientId = fromLookup;
                linkedExistingClients++;
            } else if (clientPhone || clientEmail) {
                if (matchIssues.length) {
                    errors.push({ row: r, ...caseErrCtx, errors: matchIssues });
                    continue;
                }
                resolvedClientId = fromLookup;
                if (resolvedClientId) linkedExistingClients++;
            }

            if (!resolvedClientId && (clientPhone || clientEmail || toSafeString(d.clientFirstName) || toSafeString(d.clientLastName))) {
                // Auto-create client - enforce required client fields
                const cf = toSafeString(d.clientFirstName);
                const cln = toSafeString(d.clientLastName);
                const streetAddress = toSafeString(d.clientStreetAddress);
                const city = toSafeString(d.clientCity);
                const province = toSafeString(d.clientProvince);
                const postalCode = toSafeString(d.clientPostalCode);
                const country = toSafeString(d.clientCountry) || 'India';
                const fees = toOptionalNumber(d.clientFees);

                const clientIssues = [];
                if (!clientPhone && !clientEmail) clientIssues.push('clientPhone or clientEmail is required to match/create client');
                if (clientPhone && clientPhone.length !== 10) clientIssues.push('clientPhone must be a 10-digit number');
                if (!cf) clientIssues.push('clientFirstName is required to create client');
                if (!cln) clientIssues.push('clientLastName is required to create client');
                if (!streetAddress) clientIssues.push('clientStreetAddress is required to create client');
                if (!city) clientIssues.push('clientCity is required to create client');
                if (!province) clientIssues.push('clientProvince is required to create client');
                if (!postalCode) clientIssues.push('clientPostalCode is required to create client');
                if (fees === undefined || Number.isNaN(fees)) clientIssues.push('clientFees is required to create client and must be a number');

                if (clientIssues.length > 0) {
                    errors.push({ row: r, ...caseErrCtx, errors: clientIssues });
                    continue;
                }

                // If phone/email already exists, link instead of creating (but reject ambiguity)
                const recheck = resolveCaseExcelClientFromLookups(
                    { clientPhone: d.clientPhone, clientEmail: d.clientEmail },
                    lookups
                );
                if (recheck.clientIssues.length) {
                    errors.push({ row: r, ...caseErrCtx, errors: recheck.clientIssues });
                    continue;
                }
                if (recheck.linkedClientId) {
                    resolvedClientId = recheck.linkedClientId;
                    linkedExistingClients++;
                }

                if (!resolvedClientId) {
                    const newClientId = generateClientId();
                    const clientDoc = {
                        _id: newClientId,
                        firstName: cf,
                        lastName: cln,
                        email: clientEmail || undefined,
                        phone: clientPhone,
                        streetAddress,
                        city,
                        province,
                        postalCode,
                        country,
                        fees,
                        organization: organizationId,
                        createdBy: createdByStr,
                        assignedTo: null
                    };
                    groupPendingClients.push(clientDoc);
                    addCreatedClientToCaseExcelLookups(lookups, {
                        _id: newClientId,
                        phone: clientPhone,
                        email: clientEmail || undefined
                    });
                    resolvedClientId = newClientId;
                }
            }

            if (resolvedClientId && !clientIdSeen.has(resolvedClientId)) {
                clientIdSeen.add(resolvedClientId);
                clientIds.push(resolvedClientId);
            }
        }

        const effectiveClientCount = clientCount === undefined ? clientIds.length : (Number.isNaN(clientCount) ? NaN : clientCount);
        if (Number.isNaN(effectiveClientCount)) {
            for (const doc of groupPendingClients) removePendingClientFromCaseExcelLookups(lookups, doc);
            errors.push({ row: first.rowNumber, ...caseErrCtx, errors: ['clientCount must be a number'] });
            skippedCases++;
            continue;
        }
        if (clientIds.length > effectiveClientCount) {
            for (const doc of groupPendingClients) removePendingClientFromCaseExcelLookups(lookups, doc);
            errors.push({
                row: first.rowNumber,
                ...caseErrCtx,
                errors: [`Cannot assign more than ${effectiveClientCount} client(s). Found ${clientIds.length} client rows for this caseNumber.`]
            });
            skippedCases++;
            continue;
        }

        pendingNewClients.push(...groupPendingClients);
        pendingNewCases.push({
            ...(caseNumber ? { caseNumber } : {}),
            caseType,
            partyName,
            stage,
            courtName,
            courtPremises,
            assignedTo: null,
            clientCount: effectiveClientCount,
            clients: clientIds,
            notes,
            organization: organizationId,
            createdBy: createdByStr
        });
    }

    let createdCases = 0;
    let createdClients = 0;
    try {
        const [currentClientCount, currentCaseCount] = await Promise.all([
            Client.countDocuments({ organization: organizationId, deletedAt: null }),
            Case.countDocuments({ organization: organizationId, deletedAt: null })
        ]);
        const clientLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxClients', currentClientCount);
        const caseLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxCases', currentCaseCount);

        const limitMessages = [];
        if (clientLimitInfo && pendingNewClients.length > clientLimitInfo.remaining) {
            limitMessages.push(buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo));
        }
        if (caseLimitInfo && pendingNewCases.length > caseLimitInfo.remaining) {
            limitMessages.push(buildRemainingImportLimitMessage(subscriptionSummary, 'cases', caseLimitInfo));
        }
        if (limitMessages.length) {
            return next(new ErrorResponse(limitMessages.join(' '), 403));
        }

        if (pendingNewClients.length) {
            await Client.insertMany(pendingNewClients, { ordered: true });
            createdClients = pendingNewClients.length;
        }
        if (pendingNewCases.length) {
            await Case.insertMany(pendingNewCases, { ordered: true });
            createdCases = pendingNewCases.length;
        }
    } catch (e) {
        return next(new ErrorResponse(formatMongooseErrorForUser(e).join('; ') || 'Bulk case/client import failed', 500));
    }

    // Notify assignees when a non-assignee bulk-imports unassigned cases
    if (!importerIsAssignee && createdCases > 0) {
        try {
            const assigneeUserIds = await getAssigneeUserIdsForModule(organizationId, 'cases');
            const creatorIdStr = userId.toString();
            const recipientIds = assigneeUserIds.filter((id) => id !== creatorIdStr);
            for (const assigneeId of recipientIds) {
                await Notification.create({
                    userId: assigneeId,
                    organization: organizationId,
                    type: 'case_bulk_imported',
                    title: 'Cases imported',
                    message: `${createdCases} case(s) were imported and are unassigned.`,
                    relatedEntityType: 'case',
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
        message: 'Case Excel import completed',
        data: {
            createdCases,
            skippedCases,
            createdClients,
            linkedExistingClients,
            errors
        }
    });
});

/**
 * @desc    Get case assignees for dropdown (confirm by)
 * @route   GET /api/cases/assignees
 * @access  Private (Requires 'read' permission on 'cases' module)
 */
exports.getCaseAssignees = asyncHandler(async (req, res, next) => {
    const organizationId = normalizeOrganizationId(req.user.organization);
    const assigneeUserIds = await getAssigneeUserIdsForModule(organizationId, 'cases');

    const users = await User.find({
        _id: { $in: assigneeUserIds },
        organization: organizationId,
        status: 'approved'
    })
        .select('_id firstName lastName email')
        .sort({ firstName: 1, lastName: 1 })
        .lean();

    const data = users.map((u) => ({
        id: u._id.toString(),
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email
    }));

    return res.status(200).json({
        success: true,
        count: data.length,
        data
    });
});

/**
 * @desc    Add stage row for a case
 * @route   POST /api/cases/:id/stages
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.addCaseStage = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const organizationId = normalizeOrganizationId(req.user.organization);
    const userId = req.user._id.toString();

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== userId) {
        return next(new ErrorResponse('You do not have permission to add case stages', 403));
    }

    const inputStages = Array.isArray(req.body) ? req.body : [req.body];
    if (inputStages.length === 0) {
        return next(new ErrorResponse('At least one stage is required', 400));
    }

    const validAssignees = await getAssigneeUserIdsForModule(organizationId, 'cases');

    const stagesToInsert = [];
    for (const raw of inputStages) {
        const stageData = sanitizeStagePayload(raw);

        if (!stageData.stageName) {
            return next(new ErrorResponse('Stage name is required', 400));
        }

        if (!stageData.confirmedBy) {
            return next(new ErrorResponse('Confirmed by is required', 400));
        }

        if (!isValidDateOrNull(stageData.nextDate)) {
            return next(new ErrorResponse('Invalid next date', 400));
        }

        if (!validAssignees.includes(stageData.confirmedBy)) {
            return next(new ErrorResponse('Confirmed by must be a valid case assignee', 400));
        }

        stagesToInsert.push({
            stageName: stageData.stageName,
            todaySummary: stageData.todaySummary || undefined,
            nextDate: stageData.nextDate || null,
            nextDatePurpose: stageData.nextDatePurpose || undefined,
            nextDatePreparation: stageData.nextDatePreparation || undefined,
            confirmedBy: stageData.confirmedBy,
            createdBy: userId,
            updatedBy: userId
        });
    }

    // Ensure confirmedBy users exist in the organization (avoid dangling ids)
    const confirmIds = [...new Set(stagesToInsert.map((s) => s.confirmedBy))];
    const confirmUsersCount = await User.countDocuments({
        _id: { $in: confirmIds },
        organization: organizationId,
        status: 'approved'
    });
    if (confirmUsersCount !== confirmIds.length) {
        return next(new ErrorResponse('One or more confirmedBy users are invalid for this organization', 400));
    }

    const beforeLen = caseDoc.stages.length;
    caseDoc.stages.push(...stagesToInsert);

    // Capture plain string IDs before populate replaces them with User documents
    const confirmedByIds = stagesToInsert.map((s) => String(s.confirmedBy));

    caseDoc.updatedBy = userId;
    await caseDoc.save();
    await caseDoc.populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    const createdStages = caseDoc.stages.slice(beforeLen);

    // Notify confirmedBy users to confirm stage(s)
    try {
        for (let i = 0; i < createdStages.length; i++) {
            await Notification.create({
                userId: confirmedByIds[i],
                organization: organizationId,
                type: 'case_stage_needs_confirmation',
                title: 'Stage needs confirmation',
                message: `${caseDoc.caseNumber || caseDoc._id} - Please confirm stage: ${createdStages[i].stageName}`,
                relatedEntityType: 'case',
                relatedEntityId: caseDoc._id.toString(),
                createdBy: userId
            });
        }
    } catch (err) {
        console.error('⚠️ Failed to create stage confirmation notifications:', err.message);
    }

    return res.status(201).json({
        success: true,
        message: 'Case stage(s) added successfully',
        count: createdStages.length,
        data: createdStages
    });
});

/**
 * @desc    Preview case Excel import (no DB writes). Shows what cases/clients will be created/linked.
 * @route   POST /api/cases/excel/preview
 * @access  Private (Requires 'create' permission on 'cases' module)
 */
exports.previewCasesExcelImport = asyncHandler(async (req, res, next) => {
    const organizationId = getOrganizationIdFromUser(req.user);
    const subscriptionSummary = await getEffectiveSubscriptionSummaryForUser(req.user);
    const importRowLimit = getExcelImportRowLimit(subscriptionSummary?.subscriptionPlan);

    const file = req.file;
    if (!file || !file.buffer) {
        return next(new ErrorResponse('Excel file is required (form-data field: file)', 400));
    }

    const parsed = parseCaseExcel(file.buffer, { sheetName: CASE_EXCEL_SHEET, maxRows: importRowLimit });
    if (!parsed.ok) return next(new ErrorResponse(parsed.error, 400));

    const canAssign = req.userRole && canAssignModule(req.userRole, 'cases');

    const groups = buildCaseExcelImportGroups(parsed.rows);
    const errors = [];

    const lookups = await loadCaseExcelImportLookups(organizationId, parsed.rows);

    const preview = [];
    const [currentClientCount, currentCaseCount] = await Promise.all([
        Client.countDocuments({ organization: organizationId, deletedAt: null }),
        Case.countDocuments({ organization: organizationId, deletedAt: null })
    ]);
    const clientLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxClients', currentClientCount);
    const caseLimitInfo = getRemainingLimitInfo(subscriptionSummary, 'maxCases', currentCaseCount);

    for (const [caseKey, rows] of groups.entries()) {
        const first = rows[0];
        const caseNumber = firstNonEmptyCaseExcelField(rows, 'caseNumber');
        const caseType = firstNonEmptyCaseExcelField(rows, 'caseType');
        const partyName = firstNonEmptyCaseExcelField(rows, 'partyName');
        const stageRaw = firstNonEmptyCaseExcelField(rows, 'stage');
        const stage = stageRaw || undefined;
        const courtNameRaw = firstNonEmptyCaseExcelField(rows, 'courtName');
        const courtName = courtNameRaw || undefined;
        const courtPremisesRaw = firstNonEmptyCaseExcelField(rows, 'courtPremises');
        const courtPremises = courtPremisesRaw || undefined;
        const notesRaw = firstNonEmptyCaseExcelField(rows, 'notes');
        const notes = notesRaw || undefined;
        const clientCount = firstDefinedClientCountInCaseGroup(rows);

        const caseIssues = [];
        if (!caseType) caseIssues.push('caseType is required');
        if (!partyName) caseIssues.push('partyName is required');
        if (courtPremises && CASE_COURT_PREMISES_ENUM.length > 0 && !CASE_COURT_PREMISES_ENUM.includes(courtPremises)) {
            caseIssues.push(`courtPremises must be one of: ${CASE_COURT_PREMISES_ENUM.join(', ')}`);
        }

        const anyClientFields = rows.some((rr) =>
            toSafeString(rr.data.clientId) ||
            toSafeString(rr.data.clientPhone) ||
            toSafeString(rr.data.clientEmail) ||
            toSafeString(rr.data.clientFirstName) ||
            toSafeString(rr.data.clientLastName)
        );
        if (!canAssign && anyClientFields) {
            caseIssues.push('Only users with case assignee permission can link/create clients during import');
        }

        if (caseNumber && lookups.existingCaseNumbers.has(caseNumber)) {
            caseIssues.push('A case with this caseNumber already exists');
        }

        const casePreviewErrCtx = { ...(caseNumber ? { caseNumber } : {}) };

        const clientPreviews = [];
        const resolvedClientIds = new Set();

        for (const rr of rows) {
            const r = rr.rowNumber;
            const d = rr.data;

            const {
                clientPhone,
                clientPhoneRaw,
                clientEmail,
                linkedClientId: resolvedFromLookup,
                clientIssues: matchIssues
            } = resolveCaseExcelClientFromLookups(d, lookups);

            const clientIssues = [...matchIssues];
            let action = 'none'; // none | link_existing | create_new
            let linkedClientId = resolvedFromLookup;
            if (linkedClientId) action = 'link_existing';

            if (!linkedClientId && (clientPhone || clientEmail || toSafeString(d.clientFirstName) || toSafeString(d.clientLastName))) {
                const cf = toSafeString(d.clientFirstName);
                const cln = toSafeString(d.clientLastName);
                const streetAddress = toSafeString(d.clientStreetAddress);
                const city = toSafeString(d.clientCity);
                const province = toSafeString(d.clientProvince);
                const postalCode = toSafeString(d.clientPostalCode);
                const country = toSafeString(d.clientCountry) || 'India';
                const fees = toOptionalNumber(d.clientFees);

                if (!clientPhone && !clientEmail) clientIssues.push('clientPhone or clientEmail is required to match/create client');
                if (clientPhone && clientPhone.length !== 10) clientIssues.push('clientPhone must be a 10-digit number');
                if (!cf) clientIssues.push('clientFirstName is required to create client');
                if (!cln) clientIssues.push('clientLastName is required to create client');
                if (!streetAddress) clientIssues.push('clientStreetAddress is required to create client');
                if (!city) clientIssues.push('clientCity is required to create client');
                if (!province) clientIssues.push('clientProvince is required to create client');
                if (!postalCode) clientIssues.push('clientPostalCode is required to create client');
                if (fees === undefined || Number.isNaN(fees)) clientIssues.push('clientFees is required to create client and must be a number');

                if (!clientIssues.length) {
                    action = 'create_new';
                    linkedClientId = `preview_client_${r}`;
                    addCreatedClientToCaseExcelLookups(lookups, {
                        _id: linkedClientId,
                        phone: clientPhone,
                        email: clientEmail || undefined
                    });
                }

                clientPreviews.push({
                    row: r,
                    action,
                    issues: clientIssues,
                    match: { clientId: linkedClientId || null },
                    data: {
                        clientPhone: clientPhone || '',
                        clientEmail: clientEmail || '',
                        clientFirstName: cf || '',
                        clientLastName: cln || '',
                        clientStreetAddress: streetAddress || '',
                        clientCity: city || '',
                        clientProvince: province || '',
                        clientPostalCode: postalCode || '',
                        clientCountry: country || 'India',
                        clientFees: fees ?? ''
                    }
                });
            } else if (linkedClientId) {
                clientPreviews.push({
                    row: r,
                    action: 'link_existing',
                    issues: clientIssues,
                    match: { clientId: linkedClientId },
                    data: {
                        clientPhone: clientPhone || '',
                        clientEmail: clientEmail || ''
                    }
                });
            } else {
                // no client info in this row
                clientPreviews.push({ row: r, action: 'none', issues: clientIssues, match: { clientId: null }, data: {} });
            }

            if (!clientIssues.length && linkedClientId) resolvedClientIds.add(linkedClientId);
        }

        const effectiveClientCount = clientCount === undefined ? resolvedClientIds.size : (Number.isNaN(clientCount) ? NaN : clientCount);
        if (Number.isNaN(effectiveClientCount)) caseIssues.push('clientCount must be a number');
        if (resolvedClientIds.size > effectiveClientCount) {
            caseIssues.push(`Cannot assign more than ${effectiveClientCount} client(s). Found ${resolvedClientIds.size} unique linked client(s).`);
        }

        const willCreateCase = caseIssues.length === 0 && clientPreviews.every((cp) => (cp.issues || []).length === 0);
        if (caseIssues.length > 0) errors.push({ row: first.rowNumber, ...casePreviewErrCtx, errors: caseIssues });
        for (const cp of clientPreviews) {
            if (cp.issues && cp.issues.length > 0) errors.push({ row: cp.row, ...casePreviewErrCtx, errors: cp.issues });
        }

        preview.push({
            ...(caseNumber ? { caseNumber } : {}),
            willCreate: willCreateCase,
            issues: caseIssues,
            data: {
                caseType,
                partyName,
                stage: stage || '',
                courtName: courtName || '',
                courtPremises: courtPremises || '',
                clientCount: effectiveClientCount,
                assignedTo: '',
                notes: notes || ''
            },
            clients: clientPreviews
        });
    }

    const validCases = preview.filter((p) => p.willCreate);
    const requestedCases = validCases.length;
    const requestedClients = validCases.reduce((sum, p) => {
        return sum + (p.clients || []).filter((cp) => cp.action === 'create_new' && !(cp.issues || []).length).length;
    }, 0);
    const caseLimitExceeded = Boolean(caseLimitInfo && requestedCases > caseLimitInfo.remaining);
    const clientLimitExceeded = Boolean(clientLimitInfo && requestedClients > clientLimitInfo.remaining);
    if (caseLimitExceeded) {
        errors.push({ row: null, errors: [buildRemainingImportLimitMessage(subscriptionSummary, 'cases', caseLimitInfo)] });
    }
    if (clientLimitExceeded) {
        errors.push({ row: null, errors: [buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo)] });
    }

    res.status(200).json({
        success: true,
        message: 'Case Excel preview generated',
        data: {
            cases: preview,
            totals: {
                totalCases: preview.length,
                validCases: requestedCases,
                invalidCases: preview.filter((p) => !p.willCreate).length
            },
            subscriptionLimit: {
                cases: caseLimitInfo ? {
                    limitKey: 'maxCases',
                    max: caseLimitInfo.max,
                    used: caseLimitInfo.used,
                    remaining: caseLimitInfo.remaining,
                    requested: requestedCases,
                    canImport: !caseLimitExceeded,
                    message: caseLimitExceeded ? buildRemainingImportLimitMessage(subscriptionSummary, 'cases', caseLimitInfo) : null
                } : null,
                clients: clientLimitInfo ? {
                    limitKey: 'maxClients',
                    max: clientLimitInfo.max,
                    used: clientLimitInfo.used,
                    remaining: clientLimitInfo.remaining,
                    requested: requestedClients,
                    canImport: !clientLimitExceeded,
                    message: clientLimitExceeded ? buildRemainingImportLimitMessage(subscriptionSummary, 'clients', clientLimitInfo) : null
                } : null
            },
            errors
        }
    });
});

/**
 * @desc    Update a case stage (only confirmedBy can edit)
 * @route   PUT /api/cases/:id/stages/:stageId
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.updateCaseStage = asyncHandler(async (req, res, next) => {
    const { id, stageId } = req.params;
    const organizationId = normalizeOrganizationId(req.user.organization);
    const userId = req.user._id.toString();

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    // Must be able to update the case in general
    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== userId) {
        return next(new ErrorResponse('You do not have permission to update case stages', 403));
    }

    const stage = (caseDoc.stages || []).id(stageId);
    if (!stage) {
        return next(new ErrorResponse('Case stage not found', 404));
    }

    // Lock AFTER confirmation: only confirmedBy can edit this stage
    if (stage.confirmedAt && String(stage.confirmedBy) !== userId) {
        return next(new ErrorResponse('Stage is confirmed. Only the confirmedBy user can edit it.', 403));
    }

    const payload = sanitizeStagePayload(req.body);

    if (payload.stageName !== '') stage.stageName = payload.stageName;
    if (req.body.todaySummary !== undefined) stage.todaySummary = payload.todaySummary || undefined;
    if (req.body.nextDatePurpose !== undefined) stage.nextDatePurpose = payload.nextDatePurpose || undefined;
    if (req.body.nextDatePreparation !== undefined) stage.nextDatePreparation = payload.nextDatePreparation || undefined;

    if (req.body.nextDate !== undefined) {
        if (!isValidDateOrNull(payload.nextDate)) {
            return next(new ErrorResponse('Invalid next date', 400));
        }

        const oldNextDate = stage.nextDate ? new Date(stage.nextDate) : null;
        stage.nextDate = payload.nextDate;

        // If nextDate changed, reset reminderMeta so reminders can fire again for new date.
        const oldTime = oldNextDate ? oldNextDate.getTime() : null;
        const newTime = payload.nextDate ? payload.nextDate.getTime() : null;
        if (oldTime !== newTime) {
            stage.reminderMeta = {
                before5DaysSentAt: null,
                before2DaysSentAt: null,
                before1DaySentAt: null,
                afterDateSentAt: null
            };
        }
    }

    // confirmedBy is NOT editable (keeps lock consistent)
    stage.updatedBy = userId;
    caseDoc.updatedBy = userId;
    await caseDoc.save();
    await caseDoc.populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    return res.status(200).json({
        success: true,
        message: 'Case stage updated successfully',
        data: stage
    });
});

/**
 * @desc    Confirm a case stage (only confirmedBy can confirm)
 * @route   PATCH /api/cases/:id/stages/:stageId/confirm
 * @access  Private (Requires 'update' permission on 'cases' module)
 */
exports.confirmCaseStage = asyncHandler(async (req, res, next) => {
    const { id, stageId } = req.params;
    const organizationId = normalizeOrganizationId(req.user.organization);
    const userId = req.user._id.toString();

    const caseDoc = await Case.findOne({
        _id: id,
        organization: organizationId,
        deletedAt: null
    });

    if (!caseDoc) {
        return next(new ErrorResponse('Case not found', 404));
    }

    // Must be able to update the case in general
    if (!canViewAllCases(req.userRole) && String(caseDoc.assignedTo) !== userId) {
        return next(new ErrorResponse('You do not have permission to confirm case stages', 403));
    }

    const stage = (caseDoc.stages || []).id(stageId);
    if (!stage) {
        return next(new ErrorResponse('Case stage not found', 404));
    }

    if (String(stage.confirmedBy) !== userId) {
        return next(new ErrorResponse('Only the confirmedBy user can confirm this stage', 403));
    }

    if (stage.confirmedAt) {
        return res.status(200).json({
            success: true,
            message: 'Stage already confirmed',
            data: stage
        });
    }

    stage.confirmedAt = new Date();
    stage.updatedBy = userId;
    caseDoc.updatedBy = userId;
    await caseDoc.save();
    await caseDoc.populate('stages.confirmedBy', STAGE_CONFIRM_USER_SELECT);

    return res.status(200).json({
        success: true,
        message: 'Stage confirmed successfully',
        data: stage
    });
});
