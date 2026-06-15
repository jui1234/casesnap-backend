// routes/caseRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
    createCase,
    getCases,
    getCaseAssignees,
    getCase,
    addCaseStage,
    updateCaseStage,
    confirmCaseStage,
    updateCase,
    deleteCase,
    restoreCase,
    archiveCase,
    unarchiveCase,
    downloadCaseExcelTemplate,
    exportCasesToExcel,
    importCasesFromExcel,
    previewCasesExcelImport,
    bulkAssignCases
} = require('../controllers/caseController');

const { protect } = require('../middleware/auth');
const { loadUserRole, checkPermission, requireCaseBulkAssignAccess } = require('../middleware/rbac');
const { checkSubscriptionFeature } = require('../middleware/subscriptionFeature');
const { checkCaseLimit } = require('../middleware/subscriptionLimits');

router.use(protect);
router.use(loadUserRole);

const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Only Excel files (.xlsx/.xls) are allowed'), false);
    }
});

const normalizeExcelFile = (req, res, next) => {
    if (req.file) return next();
    if (req.files) {
        const f = req.files.file?.[0] || req.files.excel?.[0] || req.files.upload?.[0];
        if (f) req.file = f;
    }
    next();
};

router.post('/', checkPermission('cases', 'create'), checkCaseLimit, createCase);
router.get('/', checkPermission('cases', 'read'), getCases);
router.get('/assignees', checkPermission('cases', 'read'), getCaseAssignees);

// Excel import/export
router.get('/excel/template', checkPermission('cases', 'read'), checkSubscriptionFeature('excel_import_export'), downloadCaseExcelTemplate);
router.get('/excel/export', checkPermission('cases', 'read'), checkSubscriptionFeature('excel_import_export'), exportCasesToExcel);
router.post('/excel/preview', checkPermission('cases', 'create'), checkSubscriptionFeature('excel_import_export'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, previewCasesExcelImport);
router.post('/excel/import', checkPermission('cases', 'create'), checkSubscriptionFeature('excel_import_export'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, importCasesFromExcel);

router.post('/bulk-assign', checkPermission('cases', 'read'), checkSubscriptionFeature('case_assignment'), requireCaseBulkAssignAccess, bulkAssignCases);

router.get('/:id', checkPermission('cases', 'read'), getCase);
router.post('/:id/stages', checkPermission('cases', 'update'), addCaseStage);
router.put('/:id/stages/:stageId', checkPermission('cases', 'update'), updateCaseStage);
router.patch('/:id/stages/:stageId/confirm', checkPermission('cases', 'update'), checkSubscriptionFeature('case_approval'), confirmCaseStage);
router.put('/:id', checkPermission('cases', 'update'), updateCase);
router.delete('/:id', checkPermission('cases', 'delete'), deleteCase);

router.put('/:id/restore', checkPermission('cases', 'update'), restoreCase);
router.put('/:id/archive', checkPermission('cases', 'update'), archiveCase);
router.put('/:id/unarchive', checkPermission('cases', 'update'), unarchiveCase);

module.exports = router;
