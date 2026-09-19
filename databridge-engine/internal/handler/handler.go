package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"strings"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/service"
	"databridge-engine/pkg/log"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Handler 所有 handler 的基类（Nunu 布局约定）：统一响应结构 + 结构化日志。
// 引擎响应结构固定为 { code, message, data }（docs/API.md 第 2 节），
// 与 Node 管理端给前端的 { code, message, result } 不同。
type Handler struct {
	logger *log.Logger
}

func NewHandler(
	logger *log.Logger,
) *Handler {
	if logger == nil {
		logger = log.DefaultLogger()
	}
	return &Handler{
		logger: logger,
	}
}

// OK 返回 { "code": 0, "message": "success", "data": ... }。
func (h *Handler) OK(c *gin.Context, data any) {
	v1.HandleEngineSuccess(c, data)
}

// Fail 返回自定义 HTTP 状态码 + 业务码，data 为 null。
func (h *Handler) Fail(c *gin.Context, httpStatus, code int, message string) {
	v1.HandleEngineFail(c, httpStatus, code, message)
}

// FailErr 把 service 层的领域错误映射为契约规定的错误码。
func (h *Handler) FailErr(c *gin.Context, err error) {
	status, code, msg := mapError(err)
	if status >= http.StatusInternalServerError {
		h.logger.Error("request failed",
			zap.String("path", c.Request.URL.Path), zap.Int("status", status), zap.String("err", err.Error()))
	}
	h.Fail(c, status, code, msg)
}

func mapError(err error) (status, code int, message string) {
	switch {
	case err == nil:
		return http.StatusOK, v1.CodeOK, v1.MessageOK
	case errors.Is(err, service.ErrInvalidRequest):
		return http.StatusBadRequest, v1.CodeBadRequest, v1.MessageValidator + ": " + trimSentinel(err)
	case errors.Is(err, service.ErrInstanceNotFound):
		return http.StatusNotFound, v1.CodeNotFound, trimSentinel(err)
	case errors.Is(err, service.ErrDuplicateInstance):
		return http.StatusConflict, v1.CodeConflict, trimSentinel(err)
	case errors.Is(err, service.ErrInternal):
		return http.StatusInternalServerError, v1.CodeInternal, trimSentinel(err)
	default:
		return http.StatusInternalServerError, v1.CodeInternal, "服务异常: " + err.Error()
	}
}

// trimSentinel 去掉 sentinel error 的英文前缀（如 "instance not found: "）。
func trimSentinel(err error) string {
	msg := err.Error()
	for _, sentinel := range []string{
		service.ErrInvalidRequest.Error(),
		service.ErrInstanceNotFound.Error(),
		service.ErrDuplicateInstance.Error(),
		service.ErrInternal.Error(),
	} {
		msg = strings.TrimPrefix(msg, sentinel)
	}
	return strings.TrimLeft(msg, " :：")
}

// bindFail 处理参数校验/反序列化错误 -> 400 / 40001。
// targets 为参与绑定的结构体指针，用于把 Go 字段名还原成 json/form 里的 camelCase 名称。
func (h *Handler) bindFail(c *gin.Context, err error, targets ...any) {
	h.Fail(c, http.StatusBadRequest, v1.CodeBadRequest, v1.MessageValidator+": "+bindMessage(err, targets...))
}

// go-playground/validator 的错误文案形如：
// Key: 'StartTaskRequest.InstanceID' Error:Field validation for 'InstanceID' failed on the 'required' tag
var validationRe = regexp.MustCompile(`Key: '([^']*)' Error:Field validation for '([^']*)' failed on the '([^']*)' tag`)

func bindMessage(err error, targets ...any) string {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) {
		field := typeErr.Field
		if field == "" {
			field = "未知字段"
		}
		return fmt.Sprintf("%s 字段类型错误（期望 %s）", field, typeErr.Type.String())
	}
	var syntaxErr *json.SyntaxError
	if errors.As(err, &syntaxErr) {
		return "请求体不是合法的 JSON"
	}

	msg := err.Error()
	if matches := validationRe.FindAllStringSubmatch(msg, -1); len(matches) > 0 {
		parts := make([]string, 0, len(matches))
		for _, m := range matches {
			parts = append(parts, fmt.Sprintf("%s 校验失败(%s)", tagName(targets, m[2]), m[3]))
		}
		return strings.Join(parts, "; ")
	}
	if strings.Contains(msg, "EOF") {
		return "请求体为空"
	}
	return msg
}

// tagName 用反射把结构体字段名映射为 json/form tag 名，找不到则原样返回。
func tagName(targets []any, fieldName string) string {
	if fieldName == "" {
		return fieldName
	}
	// validator 的 Key 形如 StructName.FieldName
	if idx := strings.LastIndex(fieldName, "."); idx >= 0 {
		fieldName = fieldName[idx+1:]
	}
	for _, target := range targets {
		if name, ok := lookupTag(target, fieldName); ok {
			return name
		}
	}
	return fieldName
}

func lookupTag(target any, fieldName string) (string, bool) {
	t := reflect.TypeOf(target)
	if t == nil {
		return "", false
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return "", false
	}
	field, ok := t.FieldByName(fieldName)
	if !ok {
		return "", false
	}
	for _, key := range []string{"json", "form", "uri"} {
		tag := field.Tag.Get(key)
		if tag == "" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name != "" && name != "-" {
			return name, true
		}
	}
	return "", false
}
