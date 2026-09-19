package v1

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// 引擎侧业务码（docs/API.md 第 2 节：Go 同步引擎响应结构 { code, message, data }）。
// 注意与 Node 管理端给前端的 { code, message, result } 不同：这里是 data 字段。
const (
	CodeOK           = 0
	MessageOK        = "success"
	CodeBadRequest   = 40001
	CodeNotFound     = 40401
	CodeConflict     = 40901
	CodeInternal     = 50000
	MessageValidator = "参数校验失败"
)

// HandleEngineSuccess 返回 { "code": 0, "message": "success", "data": { } }。
func HandleEngineSuccess(ctx *gin.Context, data interface{}) {
	ctx.JSON(http.StatusOK, Response{Code: CodeOK, Message: MessageOK, Data: data})
}

// HandleEngineFail 返回自定义 HTTP 状态码 + 业务码，data 恒为 null。
func HandleEngineFail(ctx *gin.Context, httpCode, code int, message string) {
	ctx.AbortWithStatusJSON(httpCode, Response{Code: code, Message: message, Data: nil})
}

// EndpointDTO 源/目标库快照。
type EndpointDTO struct {
	ID       string `json:"id"`
	Type     string `json:"type" binding:"omitempty,oneof=oracle mysql postgresql"`
	Database string `json:"database"`
}

// StartTaskRequest POST /api/v1/engine/tasks/start 请求体
// （Node 下发完整任务快照，引擎无状态依赖）。
type StartTaskRequest struct {
	// TaskID full/incremental 必填；cdc（数据管道）无任务归属，允许缺省（跨字段校验见 Validate）
	TaskID     string `json:"taskId"`
	InstanceID string `json:"instanceId" binding:"required"`
	// SyncMode cdc = 数据管道实时同步（契约第 0 节枚举、第 1.7 节、第 2 节模拟行为第 6 条）
	SyncMode  string `json:"syncMode" binding:"required,oneof=full incremental cdc"`
	BatchSize int    `json:"batchSize" binding:"required,min=1,max=1000000"`
	// TotalRows 总行数：full / incremental 必填且 >= 1；cdc（数据管道）无总量概念，忽略该字段
	TotalRows   int64   `json:"totalRows" binding:"omitempty,min=0"`
	FailureRate float64 `json:"failureRate" binding:"omitempty,gte=0,lte=1"`
	// IncrementalColumn 增量列：incremental 模式必填；cdc 模式不需要（位点用 cdcPosition 表达）
	IncrementalColumn string `json:"incrementalColumn"`
	// PipelineID / SyncObjects 仅 cdc（数据管道）下发时携带：管道 ID 与同步对象（表名）数组。
	// 契约第 2 节第 6 条；对普通任务不下发，保持缺省。
	PipelineID  string      `json:"pipelineId"`
	SyncObjects []string    `json:"syncObjects"`
	Source      EndpointDTO `json:"source" binding:"required"`
	Target      EndpointDTO `json:"target" binding:"required"`
	ReportURL   string      `json:"reportUrl" binding:"omitempty,url"`

	// 以下为可选字段（契约未强制），仅用于日志与假数据，缺失不影响模拟
	TaskName    string `json:"taskName"`
	SourceTable string `json:"sourceTable"`
	TargetTable string `json:"targetTable"`
	WriteMode   string `json:"writeMode" binding:"omitempty,oneof=insert upsert overwrite"`
}

// Validate 处理 binding 无法表达的跨字段规则。
func (r *StartTaskRequest) Validate() error {
	if r.SyncMode == "cdc" {
		// 数据管道：totalRows 忽略、incrementalColumn 不必填（契约第 2 节第 6 条）
	} else {
		if strings.TrimSpace(r.TaskID) == "" {
			return errors.New("taskId: 非 cdc 模式下为必填")
		}
		if r.TotalRows < 1 {
			return errors.New("totalRows: 非 cdc 模式下必须大于 0")
		}
		if r.SyncMode == "incremental" && strings.TrimSpace(r.IncrementalColumn) == "" {
			return errors.New("incrementalColumn: 增量模式下必须提供增量列")
		}
	}
	if strings.TrimSpace(r.Source.ID) == "" {
		return errors.New("source.id: 必填")
	}
	if strings.TrimSpace(r.Target.ID) == "" {
		return errors.New("target.id: 必填")
	}
	return nil
}

// StopTaskRequest POST /api/v1/engine/tasks/stop 请求体。
type StopTaskRequest struct {
	InstanceID string `json:"instanceId" binding:"required"`
}

// StartTaskData start 接口返回体。
type StartTaskData struct {
	Accepted   bool   `json:"accepted"`
	InstanceID string `json:"instanceId"`
}

// StopTaskData stop 接口返回体。
type StopTaskData struct {
	Stopped bool `json:"stopped"`
}

// HealthData GET /health 返回体。
type HealthData struct {
	Status       string `json:"status"`
	Service      string `json:"service"`
	Mock         bool   `json:"mock"`
	Version      string `json:"version"`
	TickMS       int    `json:"tickMs"`
	RunningTasks int    `json:"runningTasks"`
}

// TaskListData GET /api/v1/engine/tasks 返回体。
type TaskListData struct {
	Items []TaskView `json:"items"`
	Total int        `json:"total"`
}

// TaskView GET /api/v1/engine/tasks/:instanceId 与列表接口返回的实例快照。
type TaskView struct {
	InstanceID        string      `json:"instanceId"`
	TaskID            string      `json:"taskId"`
	TaskName          string      `json:"taskName"`
	SyncMode          string      `json:"syncMode"`
	Status            string      `json:"status"`
	Progress          int         `json:"progress"`
	TotalRows         int64       `json:"totalRows"`
	ReadRows          int64       `json:"readRows"`
	WriteRows         int64       `json:"writeRows"`
	BatchSize         int         `json:"batchSize"`
	CurrentOffset     string      `json:"currentOffset"`
	RateRowsPerSec    int64       `json:"rateRowsPerSec"`
	FailureRate       float64     `json:"failureRate"`
	IncrementalColumn string      `json:"incrementalColumn"`
	SourceTable       string      `json:"sourceTable"`
	TargetTable       string      `json:"targetTable"`
	WriteMode         string      `json:"writeMode"`
	Source            EndpointDTO `json:"source"`
	Target            EndpointDTO `json:"target"`
	ReportURL         string      `json:"reportUrl"`
	StartedAt         time.Time   `json:"startedAt"`
	FinishedAt        *time.Time  `json:"finishedAt"`
	Message           *string     `json:"message"`

	// 数据管道（cdc）专属字段：非 cdc 模式下 pipelineId 为空串、其余为 0 / null
	PipelineID  string   `json:"pipelineId"`
	SyncObjects []string `json:"syncObjects"`
	ChangeRows  int64    `json:"changeRows"`
	CurrentQps  int64    `json:"currentQps"`
	LagMs       int64    `json:"lagMs"`
	CdcPosition string   `json:"cdcPosition"`
}

// ProgressReport POST {reportUrl}/report 请求体（docs/API.md 第 1.4 节）。
type ProgressReport struct {
	InstanceID string `json:"instanceId"`
	TaskID     string `json:"taskId"`
	// PipelineID 仅 cdc 管道回报时携带（omitempty）
	PipelineID *string `json:"pipelineId,omitempty"`
	Status     string  `json:"status"`
	Progress   int     `json:"progress"`
	// TotalRows cdc 管道无总量概念：不回报该字段（契约第 1.4 节「totalRows 为 null」）
	TotalRows *int64 `json:"totalRows,omitempty"`
	ReadRows  int64  `json:"readRows"`
	WriteRows int64  `json:"writeRows"`
	// CurrentOffset 增量/全量位点；cdc 模式改用 CdcPosition 表达
	CurrentOffset  *string `json:"currentOffset"`
	RateRowsPerSec int64   `json:"rateRowsPerSec"`
	// CurrentQps / LagMs / CdcPosition 仅 cdc 管道回报时携带（契约第 1.4 节）
	CurrentQps  *int64  `json:"currentQps,omitempty"`
	LagMs       *int64  `json:"lagMs,omitempty"`
	CdcPosition *string `json:"cdcPosition,omitempty"`
	Message     *string `json:"message"`
}

// LogItem POST {reportUrl}/logs 中的单条日志（docs/API.md 第 1.3/1.4 节）。
type LogItem struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// LogsPayload POST {reportUrl}/logs 请求体。
type LogsPayload struct {
	InstanceID string    `json:"instanceId"`
	Logs       []LogItem `json:"logs"`
}
