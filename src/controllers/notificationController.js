// controllers/notificationController.js
// Notifications for assignees when non-assignee creates client/case

const Notification = require('../models/Notification');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');

/**
 * @desc    Get notifications for the logged-in user
 * @route   GET /api/notifications
 * @access  Private
 */
exports.getNotifications = asyncHandler(async (req, res, next) => {
    const userId = req.user._id.toString();
    const organizationId = (req.user.organization && req.user.organization._id)
        ? req.user.organization._id.toString()
        : (req.user.organization && req.user.organization.toString ? req.user.organization.toString() : req.user.organization);
    const { page = 1, limit = 20, read } = req.query;

    const query = {
        userId,
        organization: organizationId
    };
    if (read !== undefined && read !== '') {
        if (read === 'true' || read === true) query.read = true;
        else if (read === 'false' || read === false) query.read = false;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean(),
        Notification.countDocuments(query),
        Notification.countDocuments({ userId, organization: organizationId, read: false })
    ]);

    res.status(200).json({
        success: true,
        count: notifications.length,
        total,
        unreadCount,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        data: notifications
    });
});

/**
 * @desc    Mark a notification as read
 * @route   PATCH /api/notifications/:id/read
 * @access  Private
 */
exports.markAsRead = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const userId = req.user._id.toString();
    const organizationId = (req.user.organization && req.user.organization._id)
        ? req.user.organization._id.toString()
        : (req.user.organization && req.user.organization.toString ? req.user.organization.toString() : req.user.organization);

    const notification = await Notification.findOne({
        _id: id,
        userId,
        organization: organizationId
    });

    if (!notification) {
        return next(new ErrorResponse('Notification not found', 404));
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    res.status(200).json({
        success: true,
        message: 'Notification marked as read',
        data: notification
    });
});

/**
 * @desc    Get unread notification count for the logged-in user (lightweight, for badge)
 * @route   GET /api/notifications/unread-count
 * @access  Private
 */
exports.getUnreadCount = asyncHandler(async (req, res, next) => {
    const userId = req.user._id.toString();
    const organizationId = (req.user.organization && req.user.organization._id)
        ? req.user.organization._id.toString()
        : (req.user.organization && req.user.organization.toString ? req.user.organization.toString() : req.user.organization);

    const unreadCount = await Notification.countDocuments({ userId, organization: organizationId, read: false });

    res.status(200).json({
        success: true,
        unreadCount
    });
});

/**
 * @desc    Mark all notifications as read for the logged-in user
 * @route   PATCH /api/notifications/read-all
 * @access  Private
 */
exports.markAllAsRead = asyncHandler(async (req, res, next) => {
    const userId = req.user._id.toString();
    const organizationId = (req.user.organization && req.user.organization._id)
        ? req.user.organization._id.toString()
        : (req.user.organization && req.user.organization.toString ? req.user.organization.toString() : req.user.organization);

    const result = await Notification.updateMany(
        { userId, organization: organizationId, read: false },
        { $set: { read: true, readAt: new Date() } }
    );

    res.status(200).json({
        success: true,
        message: 'All notifications marked as read',
        modifiedCount: result.modifiedCount
    });
});
