package reader

import "context"

// Reader 源库读取接口（docs/API.md 第 2 节「第二阶段替换点」）。
//
// ReadBatch 的语义：调用方预分配 batch（长度 = 本批期望行数），
// 实现方向 batch 的元素写入行数据并返回实际读取行数 n（只允许使用 batch[:n]）。
// 真实实现里 n 可以小于 len(batch)（源表已到末尾）。
type Reader interface {
	TotalRows(ctx context.Context) (int64, error)
	ReadBatch(ctx context.Context, batch []map[string]any) (int64, error)
}

// Spec 构建读取器所需的任务快照。第二阶段换成真实驱动时，
// 在这里补充 DSN / schema / 增量游标等字段即可，service 层不受影响。
type Spec struct {
	InstanceID        string
	TaskID            string
	TaskName          string
	SyncMode          string
	SourceID          string
	SourceType        string
	Database          string
	Table             string
	IncrementalColumn string
	BatchSize         int
	TotalRows         int64
	// Unbounded 源端没有「读到底」的时刻：cdc（数据管道）日志捕获模式使用，
	// 真实实现对应 LogMiner / 逻辑复制槽这类持续订阅，TotalRows 字段此时无意义。
	Unbounded bool
}

// Builder 按任务快照创建 Reader，是第二阶段真正的替换点：
// main.go 里把 MockBuilder 换成 OracleBuilder/PostgresBuilder 即可。
type Builder interface {
	Build(ctx context.Context, spec Spec) (Reader, error)
}
