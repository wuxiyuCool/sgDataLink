package server

import (
	stdhttp "net/http"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/middleware"
	"databridge-engine/internal/router"
	"databridge-engine/pkg/server/http"

	"github.com/gin-gonic/gin"
)

// NewHTTPServer 组装 gin 引擎：模板自带的 CORS / 访问日志中间件 + 契约兼容的 panic
// recovery，挂载 docs/API.md 第 2 节的引擎路由，未知路径统一返回 404 / 40401 结构。
func NewHTTPServer(
	deps router.RouterDeps,
) *http.Server {
	if deps.Config.GetString("env") == "prod" {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()
	// 与手写版一致：不做尾斜杠重定向，未知路径一律走 NoRoute 返回契约结构
	engine.RedirectTrailingSlash = false

	s := http.NewServer(
		engine,
		deps.Logger,
		http.WithServerHost(deps.Config.GetString("http.host")),
		http.WithServerPort(deps.Config.GetInt("http.port")),
	)

	s.Use(
		middleware.RecoveryMiddleware(deps.Logger),
		middleware.CORSMiddleware(),
		middleware.ResponseLogMiddleware(deps.Logger),
		middleware.RequestLogMiddleware(deps.Logger),
	)

	// /health 与 /api/v1/engine/* 全部由 router 包注册（root 路由树）
	router.InitEngineRouter(deps, &s.Engine.RouterGroup)

	engine.NoRoute(func(c *gin.Context) {
		v1.HandleEngineFail(c, stdhttp.StatusNotFound, v1.CodeNotFound,
			"资源不存在: "+c.Request.Method+" "+c.Request.URL.Path)
	})

	return s
}
