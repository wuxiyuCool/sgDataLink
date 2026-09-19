package middleware

import (
	"fmt"
	"net/http"
	"runtime"
	"strings"

	v1 "databridge-engine/api/v1"
	"databridge-engine/pkg/log"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// RecoveryMiddleware 统一的 panic 恢复中间件：结构化日志 + 堆栈，并按契约返回
// { code: 50000, message: "服务内部错误: ...", data: null }。
// 不用 gin.Recovery，否则 500 响应结构会退化成纯文本，破坏引擎统一响应。
func RecoveryMiddleware(logger *log.Logger) gin.HandlerFunc {
	if logger == nil {
		logger = log.DefaultLogger()
	}
	return func(c *gin.Context) {
		defer func() {
			if err := recover(); err != nil {
				logger.Error("panic recovered",
					zap.String("path", c.Request.URL.Path),
					zap.String("method", c.Request.Method),
					zap.Any("err", err),
					zap.String("stack", strings.TrimSpace(stackTrace())),
					zap.String("ip", c.ClientIP()),
				)
				v1.HandleEngineFail(c, http.StatusInternalServerError, v1.CodeInternal,
					fmt.Sprintf("服务内部错误: %v", err))
			}
		}()
		c.Next()
	}
}

func stackTrace() string {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	return string(buf[:n])
}
