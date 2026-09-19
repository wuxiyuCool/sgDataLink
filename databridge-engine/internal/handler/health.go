package handler

import (
	v1 "databridge-engine/api/v1"

	"github.com/gin-gonic/gin"
)

// ServiceName 服务名，出现在 /health 回报里。
const ServiceName = "databridge-engine"

// Version 构建版本，由 Dockerfile 的
// -ldflags "-X databridge-engine/internal/handler.Version=${VERSION}" 注入。
var Version = "dev"

// HealthHandler 健康检查。
type HealthHandler struct {
	*Handler
	tickMS  int
	running func() int
}

// NewHealthHandler 构造健康检查 handler；running 回调返回引擎内运行中实例数。
func NewHealthHandler(
	handler *Handler,
	tickMS int,
	running func() int,
) *HealthHandler {
	return &HealthHandler{
		Handler: handler,
		tickMS:  tickMS,
		running: running,
	}
}

// Get GET /health
// data: { "status": "ok", "runningTasks": 3 }（外层是引擎统一响应结构 { code, message, data }）
func (h *HealthHandler) Get(c *gin.Context) {
	running := 0
	if h.running != nil {
		running = h.running()
	}
	h.OK(c, v1.HealthData{
		Status:       "ok",
		Service:      ServiceName,
		Mock:         true,
		Version:      Version,
		TickMS:       h.tickMS,
		RunningTasks: running,
	})
}
