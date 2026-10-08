package router

import (
	"databridge-engine/internal/handler"
	"databridge-engine/pkg/log"

	"github.com/spf13/viper"
)

// RouterDeps 路由装配依赖（由 wire 生成，见 cmd/server/wire/wire.go）。
// 契约 v1.12：engine 组挂 X-Engine-Token 守卫（secret 为空时保持放行 + 启动 WARN）。
type RouterDeps struct {
	Logger        *log.Logger
	Config        *viper.Viper
	HealthHandler *handler.HealthHandler
	EngineHandler *handler.EngineHandler
	SQLHandler    *handler.SQLHandler
}
