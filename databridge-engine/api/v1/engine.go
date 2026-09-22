package v1

import (
	"errors"
	"fmt"
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

// 执行模式（docs/API.md 第 4.1 / 5 节）：Node 下发快照时决定并写入 mode 字段。
// 缺省（空串）按 simulate 处理，保证契约第 2 节的模拟行为零回归。
const (
	ModeSimulate = "simulate"
	ModeReal     = "real"
)

// EndpointDTO 源/目标库快照。
// mode=real 时（契约第 5 节）额外携带真实连接信息：host/port/username/password/table。
// Password 为明文（仅内网进程间传输），引擎侧只用于建连，绝不进日志与回报。
type EndpointDTO struct {
	ID       string `json:"id"`
	Type     string `json:"type" binding:"omitempty,oneof=oracle mysql postgresql"`
	Database string `json:"database"`

	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty" binding:"omitempty,min=1,max=65535"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Table    string `json:"table,omitempty"`
}

// FieldMappingDTO 字段映射（真实模式必填项，取自契约 1.2 fieldMappings 的最小子集）。
type FieldMappingDTO struct {
	SourceField string `json:"sourceField"`
	TargetField string `json:"targetField"`
	PrimaryKey  bool   `json:"primaryKey"`
}

// StartTaskRequest POST /api/v1/engine/tasks/start 请求体
// （Node 下发完整任务快照，引擎无状态依赖）。
type StartTaskRequest struct {
	// Mode 执行模式：simulate（默认，兼容旧快照不带该字段）| real（真实库同步，契约第 5 节）
	Mode string `json:"mode" binding:"omitempty,oneof=simulate real"`
	// TaskID full/incremental 必填；cdc（数据管道）无任务归属，允许缺省（跨字段校验见 Validate）
	TaskID     string `json:"taskId"`
	InstanceID string `json:"instanceId" binding:"required"`
	// SyncMode cdc = 数据管道实时同步（契约第 0 节枚举、第 1.7 节、第 2 节模拟行为第 6 条）
	SyncMode  string `json:"syncMode" binding:"required,oneof=full incremental cdc"`
	BatchSize int    `json:"batchSize" binding:"required,min=1,max=1000000"`
	// TotalRows 总行数：simulate 的 full/incremental 必填且 >= 1；
	// real 模式由引擎 COUNT 得出，允许 0（cdc 一律忽略该字段）。
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

	// ---------- mode=real 专属（契约第 5 节）----------
	// FieldMappings 读写列映射；full/incremental 必填（cdc 轮询镜像同样需要列映射）
	FieldMappings []FieldMappingDTO `json:"fieldMappings"`
	// OffsetStart 增量起始位点（Node 持久化的上次终值，形如 "UPDATE_TIME=2026-09-18T12:00:00Z"，
	// 也接受裸值）；缺省表示从最小值开始。
	OffsetStart string `json:"offsetStart"`
	// CdcPollColumn 管道轮询列（real cdc 必填，非日志挖掘）
	CdcPollColumn string `json:"cdcPollColumn"`
	// PollIntervalSec 管道轮询间隔秒，缺省 5
	PollIntervalSec int `json:"pollIntervalSec" binding:"omitempty,min=0,max=86400"`
}

// ExecMode 归一化执行模式：空串按 simulate（旧快照无 mode 字段）。
func (r *StartTaskRequest) ExecMode() string {
	if strings.TrimSpace(r.Mode) == ModeReal {
		return ModeReal
	}
	return ModeSimulate
}

// Validate 处理 binding 无法表达的跨字段规则。
func (r *StartTaskRequest) Validate() error {
	real := r.ExecMode() == ModeReal
	if r.SyncMode == "cdc" {
		// 数据管道：totalRows 忽略、incrementalColumn 不必填（契约第 2 节第 6 条）
		if real && strings.TrimSpace(r.CdcPollColumn) == "" {
			return errors.New("cdcPollColumn: real 模式的数据管道必须提供轮询列")
		}
	} else {
		if strings.TrimSpace(r.TaskID) == "" {
			return errors.New("taskId: 非 cdc 模式下为必填")
		}
		// real 模式总量由引擎 COUNT 得出，允许 Node 不下发 totalRows
		if !real && r.TotalRows < 1 {
			return errors.New("totalRows: 非 cdc 模式下必须大于 0")
		}
		if r.SyncMode == "incremental" && strings.TrimSpace(r.IncrementalColumn) == "" {
			return errors.New("incrementalColumn: 增量模式下必须提供增量列")
		}
		// 契约第 5 节：real 的 full/incremental 必须给出字段映射；
		// cdc（管道镜像）允许省略 —— 引擎按源表全部列做同名镜像（见 service.realMappings）
		if real && len(r.FieldMappings) == 0 {
			return errors.New("fieldMappings: real 模式下必须提供字段映射")
		}
		if real {
			if err := validateFieldMappings(r.FieldMappings); err != nil {
				return err
			}
		}
	}
	if strings.TrimSpace(r.Source.ID) == "" {
		return errors.New("source.id: 必填")
	}
	if strings.TrimSpace(r.Target.ID) == "" {
		return errors.New("target.id: 必填")
	}
	if real {
		if err := validateRealEndpoint("source", r.Source); err != nil {
			return err
		}
		if err := validateRealEndpoint("target", r.Target); err != nil {
			return err
		}
	}
	return nil
}

// validateRealEndpoint 真实模式端点最小必填集：host/username/table（port 缺省按方言默认）。
func validateRealEndpoint(name string, ep EndpointDTO) error {
	if strings.TrimSpace(ep.Host) == "" {
		return fmt.Errorf("%s.host: real 模式下必填", name)
	}
	if strings.TrimSpace(ep.Username) == "" {
		return fmt.Errorf("%s.username: real 模式下必填", name)
	}
	if strings.TrimSpace(ep.Table) == "" {
		return fmt.Errorf("%s.table: real 模式下必填", name)
	}
	if t := strings.ToLower(strings.TrimSpace(ep.Type)); t != "mysql" && t != "oracle" {
		return fmt.Errorf("%s.type: real 模式仅支持 mysql / oracle，当前为 %q", name, ep.Type)
	}
	db := strings.TrimSpace(ep.Database)
	if strings.EqualFold(ep.Type, "mysql") && db == "" {
		return fmt.Errorf("%s.database: real 模式下 mysql 必须提供库名", name)
	}
	if strings.EqualFold(ep.Type, "oracle") && db == "" {
		return fmt.Errorf("%s.database: real 模式下 oracle 必须提供 service name", name)
	}
	return nil
}

// validateFieldMappings 真实模式必须有列映射（源字段 -> 目标字段），且不得重复声明目标列。
func validateFieldMappings(mappings []FieldMappingDTO) error {
	if len(mappings) == 0 {
		return errors.New("fieldMappings: real 模式下必须提供字段映射")
	}
	seen := make(map[string]struct{}, len(mappings))
	for i, m := range mappings {
		src := strings.TrimSpace(m.SourceField)
		dst := strings.TrimSpace(m.TargetField)
		if src == "" {
			return fmt.Errorf("fieldMappings[%d].sourceField: 必填", i)
		}
		if dst == "" {
			return fmt.Errorf("fieldMappings[%d].targetField: 必填", i)
		}
		key := strings.ToUpper(dst)
		if _, ok := seen[key]; ok {
			return fmt.Errorf("fieldMappings[%d].targetField: 目标列 %s 重复映射", i, dst)
		}
		seen[key] = struct{}{}
	}
	return nil
}

// SafeEndpointDTO 视图回显用的端点：剥掉口令（契约第 5 节：凭据不回报、不落日志）。
func SafeEndpointDTO(ep EndpointDTO) EndpointDTO {
	ep.Password = ""
	return ep
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
	InstanceID string `json:"instanceId"`
	TaskID     string `json:"taskId"`
	TaskName   string `json:"taskName"`
	// Mode 执行模式回显：simulate | real（契约第 4.1 / 5 节）
	Mode              string      `json:"mode"`
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
