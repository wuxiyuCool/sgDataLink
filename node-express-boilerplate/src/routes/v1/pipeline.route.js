const express = require('express');
const validate = require('../../middlewares/validate');
const pipelineValidation = require('../../validations/pipeline.validation');
const pipelineController = require('../../controllers/pipeline.controller');

/**
 * 数据管道路由（docs/API.md 第 1.7 节）。
 *
 * TODO 第二阶段挂鉴权：router.use(auth('managePipelines'))
 * Mock 阶段不鉴权，前端直接调用。
 */
const router = express.Router();

router
  .route('/')
  .get(validate(pipelineValidation.listPipelines), pipelineController.getPipelines)
  .post(validate(pipelineValidation.createPipeline), pipelineController.createPipeline);

// 动作类路径写在通配 /:id 之前，保持「具体在前、通配在后」的阅读顺序
router.post('/:id/start', validate(pipelineValidation.startPipeline), pipelineController.startPipeline);
router.post('/:id/stop', validate(pipelineValidation.stopPipeline), pipelineController.stopPipeline);
router.get('/:id/status', validate(pipelineValidation.getPipelineStatus), pipelineController.getPipelineStatus);

router
  .route('/:id')
  .get(validate(pipelineValidation.getPipeline), pipelineController.getPipeline)
  .put(validate(pipelineValidation.updatePipeline), pipelineController.updatePipeline)
  .delete(validate(pipelineValidation.deletePipeline), pipelineController.deletePipeline);

module.exports = router;
