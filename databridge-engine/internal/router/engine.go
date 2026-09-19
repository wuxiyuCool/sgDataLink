package router

import (
	"github.com/gin-gonic/gin"
)

// EngineAPIPrefix 引擎对外接口前缀（docs/API.md 第 2 节）。
const EngineAPIPrefix = "/api/v1/engine"

// InitEngineRouter 注册引擎路由：
//
//	GET  /health                       健康检查（不在前缀下，契约第 2 节表格）
//	POST /api/v1/engine/tasks/start    下发启动指令
//	POST /api/v1/engine/tasks/stop     下发停止指令
//	GET  /api/v1/engine/tasks          引擎内任务列表（?status=running 可过滤）
//	GET  /api/v1/engine/tasks/:instanceId 单实例快照
//
// r 传入路由树根（gin.Engine 的 RouterGroup），Mock 阶段无鉴权中间件。
func InitEngineRouter(
	deps RouterDeps,
	r *gin.RouterGroup,
) {
	r.GET("/health", deps.HealthHandler.Get)

	engine := r.Group(EngineAPIPrefix)
	{
		engine.POST("/tasks/start", deps.EngineHandler.Start)
		engine.POST("/tasks/stop", deps.EngineHandler.Stop)
		engine.GET("/tasks", deps.EngineHandler.List)
		engine.GET("/tasks/:instanceId", deps.EngineHandler.Get)
	}
}
