package model

import (
	"math"
	"time"
)

// 同步模式（docs/API.md 第 0 节枚举）
const (
	SyncModeFull        = "full"
	SyncModeIncremental = "incremental"
	// SyncModeCDC 数据管道实时同步（契约第 1.7 节 / 第 2 节模拟行为第 6 条）
	SyncModeCDC = "cdc"
)

// 实例状态（docs/API.md 第 0 节枚举）
const (
	StatusIdle    = "idle"
	StatusRunning = "running"
	StatusSuccess = "success"
	StatusFailed  = "failed"
	StatusStopped = "stopped"
)

// Endpoint 源/目标库的快照信息（Mock 阶段仅用于日志与假数据生成）。
type Endpoint struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Database string `json:"database"`
}

// MockTask 引擎内一个运行实例的完整状态（任务快照 + 模拟进度）。
//
// 并发约定：mock 状态存储（memRepo）在写入和读取时都会做值拷贝，
// 因此 runner goroutine 与 handler 读取的是彼此独立的副本，不存在数据竞争。
// 第二阶段换成真实存储时，只要保持"取到的对象可安全只读"这一约定即可。
type MockTask struct {
	InstanceID        string  `json:"instanceId"`
	TaskID            string  `json:"taskId"`
	TaskName          string  `json:"taskName"`
	SyncMode          string  `json:"syncMode"`
	BatchSize         int     `json:"batchSize"`
	TotalRows         int64   `json:"totalRows"`
	FailureRate       float64 `json:"failureRate"`
	IncrementalColumn string  `json:"incrementalColumn"`
	// PipelineID / SyncObjects 仅 cdc（数据管道）实例有值：管道 ID 与同步对象（表名）列表
	PipelineID  string   `json:"pipelineId"`
	SyncObjects []string `json:"syncObjects"`
	SourceTable string   `json:"sourceTable"`
	TargetTable string   `json:"targetTable"`
	WriteMode   string   `json:"writeMode"`
	Source      Endpoint `json:"source"`
	Target      Endpoint `json:"target"`
	ReportURL   string   `json:"reportUrl"`

	Status         string     `json:"status"`
	Progress       int        `json:"progress"`
	ReadRows       int64      `json:"readRows"`
	WriteRows      int64      `json:"writeRows"`
	CurrentOffset  string     `json:"currentOffset"`
	RateRowsPerSec int64      `json:"rateRowsPerSec"`
	StartedAt      time.Time  `json:"startedAt"`
	FinishedAt     *time.Time `json:"finishedAt"`
	Message        *string    `json:"message"`

	// cdc（数据管道）实时指标：changeRows 为累计捕获的变更事件数，其余为最近一次 tick 的快照
	ChangeRows  int64  `json:"changeRows"`
	CurrentQps  int64  `json:"currentQps"`
	LagMs       int64  `json:"lagMs"`
	CdcPosition string `json:"cdcPosition"`

	// 以下为模拟过程内部状态，不属于对外契约
	BatchesDone int    `json:"-"`
	FailAtBatch int    `json:"-"` // <=0 表示不失败
	FailMsg     string `json:"-"`
}

// Clone 返回值拷贝（含指针与切片字段），用于跨 goroutine 传递快照。
func (t *MockTask) Clone() *MockTask {
	if t == nil {
		return nil
	}
	cp := *t
	if t.FinishedAt != nil {
		v := *t.FinishedAt
		cp.FinishedAt = &v
	}
	if t.Message != nil {
		v := *t.Message
		cp.Message = &v
	}
	if t.SyncObjects != nil {
		cp.SyncObjects = append([]string(nil), t.SyncObjects...)
	}
	return &cp
}

// IsCdc 是否为数据管道（cdc）实例：无总量、无限运行直至 stop。
func (t *MockTask) IsCdc() bool {
	return t.SyncMode == SyncModeCDC
}

// TotalBatches 按 batchSize 分片后的总批次。
func (t *MockTask) TotalBatches() int {
	if t.BatchSize <= 0 || t.TotalRows <= 0 {
		return 0
	}
	return int(math.Ceil(float64(t.TotalRows) / float64(t.BatchSize)))
}

// IsTerminal 判断实例是否已进入终态。
func (t *MockTask) IsTerminal() bool {
	switch t.Status {
	case StatusSuccess, StatusFailed, StatusStopped:
		return true
	default:
		return false
	}
}

// Incr 按一批推进读取/写入行数并更新进度，返回推进后的进度百分比。
// 位点由调用方在推进之后单独设置（见 service.nextOffset）。
func (t *MockTask) Incr(read, write int64) int {
	t.ReadRows += read
	if t.WriteRows+write > t.ReadRows {
		t.WriteRows = t.ReadRows
	} else {
		t.WriteRows += write
	}
	t.BatchesDone++
	t.Progress = t.calcProgress()
	return t.Progress
}

// IncrCdc 推进 cdc（数据管道）实例的累计量：events 为本 tick 捕获的变更事件数，
// applied 为其中已落库的行数。progress 恒为 0（契约第 2 节第 6 条：管道无总量、不回报进度），
// BatchesDone 复用为 tick 计数，供终态日志/回报使用。
func (t *MockTask) IncrCdc(events, applied int64) {
	if events < 0 {
		events = 0
	}
	if applied < 0 {
		applied = 0
	}
	if applied > events {
		applied = events
	}
	t.ChangeRows += events
	t.ReadRows += events
	t.WriteRows += applied
	t.BatchesDone++
	t.Progress = 0
}

func (t *MockTask) calcProgress() int {
	if t.TotalRows <= 0 {
		return 100
	}
	p := int(t.ReadRows * 100 / t.TotalRows)
	if p > 100 {
		p = 100
	}
	if p < 0 {
		p = 0
	}
	return p
}

// Finish 设置终态：状态、进度、结束时间、消息。
func (t *MockTask) Finish(status string, progress int, message string) {
	t.Status = status
	now := time.Now().UTC().Truncate(time.Millisecond)
	t.FinishedAt = &now
	if status == StatusSuccess {
		t.Progress = 100
	} else if progress >= 0 {
		t.Progress = progress
	}
	if message == "" {
		t.Message = nil
		return
	}
	t.Message = &message
}
