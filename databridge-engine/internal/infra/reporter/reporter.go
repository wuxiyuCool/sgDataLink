package reporter

import (
	"context"

	v1 "databridge-engine/api/v1"
)

// Reporter 回报 Node 管理端的接口（docs/API.md 第 2 节「第二阶段替换点」）。
//
// Report     -> POST {baseURL}/report
// ReportLogs -> POST {baseURL}/logs
//
// 约定：返回 error 只表示回报失败，调用方（service）记日志即可，不得因此中断同步任务。
type Reporter interface {
	Report(ctx context.Context, r *v1.ProgressReport) error
	ReportLogs(ctx context.Context, instanceID string, logs []v1.LogItem) error
}

// Builder 按 reportUrl 创建 Reporter（每个任务可能回报到不同地址）。
type Builder interface {
	Build(baseURL string) Reporter
}
