package model

import (
	"fmt"
	"math"
	"strings"
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

// 执行模式（docs/API.md 第 4.1 节 Node 侧判定、第 5 节引擎真实同步）
const (
	// ModeSimulate 内存模拟执行（契约第 2 节 Mock 规格，默认）
	ModeSimulate = "simulate"
	// ModeReal 真实数据库同步（契约第 5 节）
	ModeReal = "real"
)

// 冲突策略（docs/API.md 第 0 节 writeMode 枚举）
const (
	WriteModeInsert    = "insert"
	WriteModeUpsert    = "upsert"
	WriteModeOverwrite = "overwrite"
)

// Endpoint 源/目标库的快照信息。
// simulate 模式只用 ID/Type/Database（日志与假数据）；real 模式补齐真实连接信息。
//
// Password 带 json:"-"：任何把任务快照序列化成 JSON 的路径（内存仓储、日志字段、
// 未来的持久化）都不可能把口令带出去。
type Endpoint struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Database string `json:"database"`

	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"-"`
	// Table real 模式下的表名（可带 schema/owner 前缀）
	Table string `json:"table,omitempty"`
}

// Label 日志安全标识：host:port/database/table，绝不含口令。
func (e Endpoint) Label() string {
	table := strings.TrimSpace(e.Table)
	if table == "" {
		table = "-"
	}
	host := strings.TrimSpace(e.Host)
	if host == "" {
		// simulate 模式没有连接信息，退回数据源标识
		return fmt.Sprintf("%s:%s/%s", strings.TrimSpace(e.ID), strings.TrimSpace(e.Type), strings.TrimSpace(e.Database))
	}
	return fmt.Sprintf("%s:%d/%s/%s", host, e.Port, strings.TrimSpace(e.Database), table)
}

// FieldMapping 字段映射（real 模式的读写列清单；primaryKey 决定 upsert 匹配列）。
type FieldMapping struct {
	SourceField string `json:"sourceField"`
	TargetField string `json:"targetField"`
	PrimaryKey  bool   `json:"primaryKey"`
}

// MockTask 引擎内一个运行实例的完整状态（任务快照 + 模拟/真实进度）。
//
// 并发约定：mock 状态存储（memRepo）在写入和读取时都会做值拷贝，
// 因此 runner goroutine 与 handler 读取的是彼此独立的副本，不存在数据竞争。
// 第二阶段换成真实存储时，只要保持"取到的对象可安全只读"这一约定即可。
type MockTask struct {
	InstanceID string `json:"instanceId"`
	TaskID     string `json:"taskId"`
	TaskName   string `json:"taskName"`
	// Mode 执行模式：simulate（默认）| real（契约第 5 节真实同步）
	Mode              string  `json:"mode"`
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

	// ---------- real 模式专属（契约第 5 节）----------
	// FieldMappings 读写列映射；cdc 管道未下发时由引擎按源表全列同名镜像
	FieldMappings []FieldMapping `json:"fieldMappings,omitempty"`
	// OffsetStart Node 持久化的起始位点（形如 "UPDATE_TIME=2026-09-18T12:00:00Z"，也可裸值）
	OffsetStart string `json:"offsetStart,omitempty"`
	// CdcPollColumn 管道轮询列（real cdc 必填）
	CdcPollColumn string `json:"cdcPollColumn,omitempty"`
	// PollIntervalSec 管道轮询间隔秒，<=0 时按 DefaultPollIntervalSec
	PollIntervalSec int `json:"pollIntervalSec,omitempty"`

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
	if t.FieldMappings != nil {
		cp.FieldMappings = append([]FieldMapping(nil), t.FieldMappings...)
	}
	return &cp
}

// IsReal 是否为真实数据库同步实例（契约第 5 节）；否则走第 2 节的模拟行为。
func (t *MockTask) IsReal() bool {
	return t.Mode == ModeReal
}

// DefaultPollIntervalSec 管道轮询默认间隔（契约第 5 节：pollIntervalSec 缺省 5s）。
const DefaultPollIntervalSec = 5

// PollInterval 管道一轮轮询的间隔。
func (t *MockTask) PollInterval() time.Duration {
	sec := t.PollIntervalSec
	if sec <= 0 {
		sec = DefaultPollIntervalSec
	}
	return time.Duration(sec) * time.Second
}

// WriteModeOrDefault 冲突策略，空值按 insert（契约默认）。
func (t *MockTask) WriteModeOrDefault() string {
	switch t.WriteMode {
	case WriteModeUpsert, WriteModeOverwrite:
		return t.WriteMode
	default:
		return WriteModeInsert
	}
}

// PrimaryKeySourceFields 映射里标了主键的源字段（全量分页的稳定排序依据）。
func (t *MockTask) PrimaryKeySourceFields() []string {
	out := make([]string, 0, len(t.FieldMappings))
	for _, m := range t.FieldMappings {
		if m.PrimaryKey {
			out = append(out, m.SourceField)
		}
	}
	return out
}

// PrimaryKeyTargetFields 映射里标了主键的目标字段（upsert 的匹配列）。
func (t *MockTask) PrimaryKeyTargetFields() []string {
	out := make([]string, 0, len(t.FieldMappings))
	for _, m := range t.FieldMappings {
		if m.PrimaryKey {
			out = append(out, m.TargetField)
		}
	}
	return out
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
