package router

import (
	"strings"

	"databridge-engine/internal/middleware"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// EngineAPIPrefix 引擎对外接口前缀（docs/API.md 第 2 节）。
const EngineAPIPrefix = "/api/v1/engine"

// InitEngineRouter 注册引擎路由：
//
//	GET  /health                       健康检查（不在前缀下，契约第 2 节表格，免 token）
//	POST /api/v1/engine/tasks/start    下发启动指令
//	POST /api/v1/engine/tasks/stop     下发停止指令
//	GET  /api/v1/engine/tasks          引擎内任务列表（?status=running 可过滤）
//	GET  /api/v1/engine/tasks/:instanceId 单实例快照
//	POST /api/v1/engine/sql/query      通用 SQL 查询（契约 v1.12）
//	POST /api/v1/engine/sql/exec       通用 SQL 执行（契约 v1.12）
//
// 鉴权（契约 v1.12「引擎共享密钥」）：engine.shared_secret 非空时整组要求
// X-Engine-Token；为空时放行并打一条启动 WARN（平滑过渡态）。
func InitEngineRouter(
	deps RouterDeps,
	r *gin.RouterGroup,
) {
	r.GET("/health", deps.HealthHandler.Get)

	engine := r.Group(EngineAPIPrefix)
	secret := strings.TrimSpace(deps.Config.GetString("engine.shared_secret"))
	if secret == "" {
		deps.Logger.Warn("ENGINE_SHARED_SECRET 未配置：引擎接口处于无鉴权过渡态，请尽快双侧配置同值密钥")
	} else {
		engine.Use(middleware.EngineTokenMiddleware(secret))
		deps.Logger.Info("engine token guard enabled", zap.String("header", middleware.EngineTokenHeader))
	}
	{
		engine.POST("/tasks/start", deps.EngineHandler.Start)
		engine.POST("/tasks/stop", deps.EngineHandler.Stop)
		engine.GET("/tasks", deps.EngineHandler.List)
		engine.GET("/tasks/:instanceId", deps.EngineHandler.Get)
		engine.POST("/sql/query", deps.SQLHandler.Query)
		engine.POST("/sql/exec", deps.SQLHandler.Exec)
	}
}
