const express = require('express');
const validate = require('../../middlewares/validate');
const taskValidation = require('../../validations/task.validation');
const taskController = require('../../controllers/task.controller');

/**
 * 同步任务路由（docs/API.md 第 1.2 节）。
 *
 * TODO 第二阶段挂鉴权：router.use(auth('manageTasks'))
 * Mock 阶段不鉴权，前端直接调用。
 */
const router = express.Router();

router
  .route('/')
  .get(validate(taskValidation.listTasks), taskController.getTasks)
  .post(validate(taskValidation.createTask), taskController.createTask);

// 动作类路径是两段（/:id/start），与下面的单段 /:id 不冲突；按「具体在前、通配在后」书写便于阅读
router.post('/:id/start', validate(taskValidation.startTask), taskController.startTask);
router.post('/:id/stop', validate(taskValidation.stopTask), taskController.stopTask);
router.get('/:id/progress', validate(taskValidation.getTaskProgress), taskController.getTaskProgress);
router.get('/:id/instances', validate(taskValidation.getTaskInstances), taskController.getTaskInstances);

router
  .route('/:id')
  .get(validate(taskValidation.getTask), taskController.getTask)
  .put(validate(taskValidation.updateTask), taskController.updateTask)
  .delete(validate(taskValidation.deleteTask), taskController.deleteTask);

module.exports = router;
