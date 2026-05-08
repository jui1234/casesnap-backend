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

router.post('/', checkPermission('cases', 'create'), createCase);
router.get('/', checkPermission('cases', 'read'), getCases);
router.get('/assignees', checkPermission('cases', 'read'), getCaseAssignees);

// Excel import/export
router.get('/excel/template', checkPermission('cases', 'read'), downloadCaseExcelTemplate);
router.get('/excel/export', checkPermission('cases', 'read'), exportCasesToExcel);
router.post('/excel/preview', checkPermission('cases', 'create'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, previewCasesExcelImport);
router.post('/excel/import', checkPermission('cases', 'create'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, importCasesFromExcel);

router.post('/bulk-assign', checkPermission('cases', 'read'), requireCaseBulkAssignAccess, bulkAssignCases);

router.get('/:id', checkPermission('cases', 'read'), getCase);
router.post('/:id/stages', checkPermission('cases', 'update'), addCaseStage);
router.put('/:id/stages/:stageId', checkPermission('cases', 'update'), updateCaseStage);
router.patch('/:id/stages/:stageId/confirm', checkPermission('cases', 'update'), confirmCaseStage);
router.put('/:id', checkPermission('cases', 'update'), updateCase);
router.delete('/:id', checkPermission('cases', 'delete'), deleteCase);

router.put('/:id/restore', checkPermission('cases', 'update'), restoreCase);
router.put('/:id/archive', checkPermission('cases', 'update'), archiveCase);
router.put('/:id/unarchive', checkPermission('cases', 'update'), unarchiveCase);

module.exports = router;
