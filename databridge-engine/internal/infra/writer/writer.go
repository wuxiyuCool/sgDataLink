package writer

import "context"

// Writer 目标库写入接口（docs/API.md 第 2 节「第二阶段替换点」）。
// 返回值为实际提交行数（mock 实现会按比例略微小于读取行数）。
type Writer interface {
	WriteBatch(ctx context.Context, batch []map[string]any) (int64, error)
}

// Spec 构建写入器所需的任务快照。第二阶段补充 DSN、主键列表、冲突策略等字段。
type Spec struct {
	InstanceID string
	TaskID     string
	TaskName   string
	SyncMode   string
	TargetID   string
	TargetType string
	Database   string
	Table      string
	WriteMode  string
	BatchSize  int
}

// Builder 按任务快照创建 Writer，是第二阶段的替换点。
type Builder interface {
	Build(ctx context.Context, spec Spec) (Writer, error)
}
