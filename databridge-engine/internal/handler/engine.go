package handler

import (
	"net/http"
	"strings"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/service"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// EngineHandler 引擎任务接口：start / stop / list / get（docs/API.md 第 2 节）。
type EngineHandler struct {
	*Handler
	taskService service.TaskService
}

func NewEngineHandler(
	handler *Handler,
	taskService service.TaskService,
) *EngineHandler {
	return &EngineHandler{
		Handler:     handler,
		taskService: taskService,
	}
}

// Start POST /api/v1/engine/tasks/start
// 接收 Node 下发的完整任务快照，拉起 goroutine 模拟同步。
// 同一 instanceId 重复下发 -> 409 / code 40901。
func (h *EngineHandler) Start(c *gin.Context) {
	var req v1.StartTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.bindFail(c, err, &req)
		return
	}
	data, err := h.taskService.Start(c.Request.Context(), &req)
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.logger.Info("start accepted",
		zap.String("instanceId", data.InstanceID), zap.String("taskId", req.TaskID))
	h.OK(c, data)
}

// Stop POST /api/v1/engine/tasks/stop
// 请求体 { "instanceId": "inst-3001" } -> data { "stopped": true }；不存在 -> 404 / 40401。
func (h *EngineHandler) Stop(c *gin.Context) {
	var req v1.StopTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.bindFail(c, err, &req)
		return
	}
	data, err := h.taskService.Stop(c.Request.Context(), req.InstanceID)
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.logger.Info("stop accepted", zap.String("instanceId", req.InstanceID))
	h.OK(c, data)
}

// taskListQuery GET /api/v1/engine/tasks 的查询参数。
type taskListQuery struct {
	Status string `form:"status" binding:"omitempty,oneof=idle running success failed stopped"`
}

// List GET /api/v1/engine/tasks
// 引擎内任务列表（契约：当前引擎内运行中任务列表；默认返回全部，可用 ?status=running 过滤）。
func (h *EngineHandler) List(c *gin.Context) {
	var q taskListQuery
	if err := c.ShouldBindQuery(&q); err != nil {
		h.bindFail(c, err, &q)
		return
	}
	data, err := h.taskService.List(c.Request.Context(), strings.TrimSpace(q.Status))
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.OK(c, data)
}

// Get GET /api/v1/engine/tasks/:instanceId
// 单实例模拟状态快照；不存在 -> 404 / 40401。
func (h *EngineHandler) Get(c *gin.Context) {
	instanceID := strings.TrimSpace(c.Param("instanceId"))
	if instanceID == "" {
		h.Fail(c, http.StatusBadRequest, v1.CodeBadRequest, v1.MessageValidator+": instanceId 必填")
		return
	}
	view, err := h.taskService.Get(c.Request.Context(), instanceID)
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.OK(c, view)
}
