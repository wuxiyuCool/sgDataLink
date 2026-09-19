const express = require('express');
const validate = require('../../middlewares/validate');
const taskInstanceValidation = require('../../validations/taskInstance.validation');
const taskInstanceController = require('../../controllers/taskInstance.controller');

/**
 * 任务运行实例路由（docs/API.md 第 1.3 节）。
 *
 * TODO 第二阶段挂鉴权：router.use(auth('getTaskInstances'))
 */
const router = express.Router();

router.get('/', validate(taskInstanceValidation.listInstances), taskInstanceController.getInstances);

router.get('/:id/logs', validate(taskInstanceValidation.getInstanceLogs), taskInstanceController.getInstanceLogs);

router.get('/:id/offsets', validate(taskInstanceValidation.getInstanceOffsets), taskInstanceController.getInstanceOffsets);

router.get('/:id', validate(taskInstanceValidation.getInstance), taskInstanceController.getInstance);

module.exports = router;
