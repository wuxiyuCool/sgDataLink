const express = require('express');
const validate = require('../../middlewares/validate');
const alertRecordValidation = require('../../validations/alertrecord.validation');
const alertRecordController = require('../../controllers/alertrecord.controller');

/**
 * 告警记录路由（docs/API.md 第 1.10 节）。
 * 记录由 services/alert.service.js 的触发链路写入，这里只读 + 标记已读。
 */
const router = express.Router();

router.get('/', validate(alertRecordValidation.listAlertRecords), alertRecordController.getAlertRecords);
router.patch('/:id/read', validate(alertRecordValidation.markAlertRecordRead), alertRecordController.markAlertRecordRead);

router.get('/:id', validate(alertRecordValidation.getAlertRecord), alertRecordController.getAlertRecord);

module.exports = router;
