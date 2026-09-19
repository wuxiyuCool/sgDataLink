package service

import "errors"

// 领域错误：handler 负责把它们映射为 HTTP 状态码 + 业务码（docs/API.md 第 2 节）
var (
	// ErrInvalidRequest 参数不合法 -> 400 / 40001
	ErrInvalidRequest = errors.New("invalid request")
	// ErrInstanceNotFound 实例不存在 -> 404 / 40401
	ErrInstanceNotFound = errors.New("instance not found")
	// ErrDuplicateInstance 同一 instanceId 重复下发 -> 409 / 40901（幂等保护）
	ErrDuplicateInstance = errors.New("duplicate instance")
	// ErrInternal 内部错误 -> 500 / 50001
	ErrInternal = errors.New("internal error")
)
