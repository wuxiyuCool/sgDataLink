const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricTaskValidation = require('../../validations/metrictask.validation');
const metricTaskController = require('../../controllers/metrictask.controller');

/**
 * 清洗汇总任务路由（docs/API.md 1.12 §7.2）：整组 JWT。
 */
const router = express.Router();

router.use(auth());

router.post('/preview', validate(metricTaskValidation.previewPlan), metricTaskController.preview);

router
  .route('/')
  .get(validate(metricTaskValidation.listTasks), metricTaskController.getTasks)
  .post(validate(metricTaskValidation.createTask), metricTaskController.createTask);

router
  .route('/:id')
  .get(validate(metricTaskValidation.getTask), metricTaskController.getTask)
  .put(validate(metricTaskValidation.updateTask), metricTaskController.updateTask)
  .delete(validate(metricTaskValidation.deleteTask), metricTaskController.deleteTask);

router.post('/:id/run', validate(metricTaskValidation.runTask), metricTaskController.run);
router.get('/:id/runs', validate(metricTaskValidation.listRuns), metricTaskController.getRuns);

module.exports = router;
