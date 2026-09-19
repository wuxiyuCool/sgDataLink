package router

import (
	"databridge-engine/internal/handler"
	"databridge-engine/pkg/log"

	"github.com/spf13/viper"
)

// RouterDeps 路由装配依赖（由 wire 生成，见 cmd/server/wire/wire.go）。
// Mock 阶段无鉴权，故模板里的 JWT 字段已移除。
type RouterDeps struct {
	Logger        *log.Logger
	Config        *viper.Viper
	HealthHandler *handler.HealthHandler
	EngineHandler *handler.EngineHandler
}
