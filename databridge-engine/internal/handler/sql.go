package handler

import (
	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/service"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// SQLHandler 通用 SQL 执行接口（docs/API.md 第 2 节，契约 v1.12）：
// POST /api/v1/engine/sql/query 与 /sql/exec。凭据只用于建连，不进日志与回报。
type SQLHandler struct {
	*Handler
	sqlService service.SQLService
}

func NewSQLHandler(handler *Handler, sqlService service.SQLService) *SQLHandler {
	return &SQLHandler{Handler: handler, sqlService: sqlService}
}

// Query POST /api/v1/engine/sql/query
func (h *SQLHandler) Query(c *gin.Context) {
	var req v1.SQLQueryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.bindFail(c, err, &req)
		return
	}
	if err := req.Validate(); err != nil {
		h.Fail(c, 400, v1.CodeBadRequest, v1.MessageValidator+": "+err.Error())
		return
	}
	data, err := h.sqlService.Query(c.Request.Context(), &req)
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.logger.Info("sql query done", zap.Int("rows", data.RowCount), zap.Int64("elapsedMs", data.ElapsedMs))
	h.OK(c, data)
}

// Exec POST /api/v1/engine/sql/exec
func (h *SQLHandler) Exec(c *gin.Context) {
	var req v1.SQLExecRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.bindFail(c, err, &req)
		return
	}
	if err := req.Validate(); err != nil {
		h.Fail(c, 400, v1.CodeBadRequest, v1.MessageValidator+": "+err.Error())
		return
	}
	data, err := h.sqlService.Exec(c.Request.Context(), &req)
	if err != nil {
		h.FailErr(c, err)
		return
	}
	h.logger.Info("sql exec accepted", zap.String("instanceId", req.InstanceID), zap.Int("statements", len(req.Statements)))
	h.OK(c, data)
}
