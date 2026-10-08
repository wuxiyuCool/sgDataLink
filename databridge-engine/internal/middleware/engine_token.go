package middleware

import (
	"net/http"

	v1 "databridge-engine/api/v1"

	"github.com/gin-gonic/gin"
)

// EngineTokenHeader 共享密钥请求头（docs/API.md 第 2 节「引擎共享密钥」，契约 v1.12）。
const EngineTokenHeader = "X-Engine-Token"

// EngineTokenMiddleware 校验 X-Engine-Token；不匹配 -> HTTP 401 + code 40101。
// secret 为空时不应挂载本中间件（调用方负责跳过并保持 WARN），此处不再兜底放行，
// 避免出现「以为开了鉴权其实没开」的静默态。
func EngineTokenMiddleware(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader(EngineTokenHeader) != secret {
			v1.HandleEngineFail(c, http.StatusUnauthorized, v1.CodeEngineToken, "X-Engine-Token 缺失或不匹配")
			c.Abort()
			return
		}
		c.Next()
	}
}
