// routes/clientRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
    createClient,
    getClients,
    getClient,
    updateClient,
    deleteClient,
    restoreClient,
    archiveClient,
    unarchiveClient,
    downloadClientExcelTemplate,
    exportClientsToExcel,
    importClientsFromExcel,
    previewClientsExcelImport,
    bulkAssignClients
} = require('../controllers/clientController');

const { protect } = require('../middleware/auth');
const { loadUserRole, checkPermission, requireClientBulkAssignAccess } = require('../middleware/rbac');
const { checkSubscriptionFeature } = require('../middleware/subscriptionFeature');
const { checkClientLimit } = require('../middleware/subscriptionLimits');

// All routes require authentication and role loading
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

// CRUD routes with RBAC permissions
router.post('/', checkPermission('client', 'create'), checkClientLimit, createClient);
router.get('/', checkPermission('client', 'read'), getClients);

// Excel import/export
router.get('/excel/template', checkPermission('client', 'read'), checkSubscriptionFeature('excel_import_export'), downloadClientExcelTemplate);
router.get('/excel/export', checkPermission('client', 'read'), checkSubscriptionFeature('excel_import_export'), exportClientsToExcel);
router.post('/excel/preview', checkPermission('client', 'create'), checkSubscriptionFeature('excel_import_export'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, previewClientsExcelImport);
router.post('/excel/import', checkPermission('client', 'create'), checkSubscriptionFeature('excel_import_export'), excelUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'excel', maxCount: 1 },
    { name: 'upload', maxCount: 1 }
]), normalizeExcelFile, importClientsFromExcel);

router.post('/bulk-assign', checkPermission('client', 'read'), checkSubscriptionFeature('case_assignment'), requireClientBulkAssignAccess, bulkAssignClients);

router.get('/:id', checkPermission('client', 'read'), getClient);
router.put('/:id', checkPermission('client', 'update'), updateClient);
router.delete('/:id', checkPermission('client', 'delete'), deleteClient);

// Additional routes
router.put('/:id/restore', checkPermission('client', 'update'), restoreClient);
router.put('/:id/archive', checkPermission('client', 'update'), archiveClient);
router.put('/:id/unarchive', checkPermission('client', 'update'), unarchiveClient);

module.exports = router;
