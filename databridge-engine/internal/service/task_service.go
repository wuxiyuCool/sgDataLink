package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/infra/dbio"
	"databridge-engine/internal/infra/reader"
	"databridge-engine/internal/infra/reporter"
	"databridge-engine/internal/infra/writer"
	"databridge-engine/internal/model"
	"databridge-engine/internal/repository"
	"databridge-engine/pkg/log"

	"go.uber.org/zap"
)

// TaskService 引擎对外的用例入口：只依赖接口（TaskRepository / Reader.Builder /
// Writer.Builder / Reporter.Builder），第二阶段替换 mock 实现时 handler 与本层都不需要改。
type TaskService interface {
	// Start 接收启动指令，拉起 goroutine 模拟同步
	Start(ctx context.Context, req *v1.StartTaskRequest) (*v1.StartTaskData, error)
	// Stop 下发停止指令（context cancel）
	Stop(ctx context.Context, instanceID string) (*v1.StopTaskData, error)
	// List 当前引擎内任务列表，statusFilter 为空表示不过滤
	List(ctx context.Context, statusFilter string) (*v1.TaskListData, error)
	// Get 单实例模拟状态快照
	Get(ctx context.Context, instanceID string) (*v1.TaskView, error)
	// RunningCount 运行中实例数量（健康检查用）
	RunningCount(ctx context.Context) int
	// Shutdown 停止全部实例（进程退出时调用）
	Shutdown(ctx context.Context)
}

// Options 运行参数（来自 config/*.yml 的 engine: 节，可被环境变量覆盖）。
type Options struct {
	// Tick 每批推进的时间间隔（MOCK_TICK_MS）
	Tick time.Duration
	// DefaultReportURL 请求未携带 reportUrl 时的兜底地址（NODE_REPORT_URL）
	DefaultReportURL string
	// ReportTimeout 单次回报请求超时
	ReportTimeout time.Duration
	// MaxHistory 内存中保留的终态实例数量上限，超出后淘汰最早结束的
	MaxHistory int
}

func (o *Options) withDefaults() {
	if o.Tick <= 0 {
		o.Tick = time.Second
	}
	if o.ReportTimeout <= 0 {
		o.ReportTimeout = 3 * time.Second
	}
	if o.MaxHistory <= 0 {
		o.MaxHistory = 200
	}
	o.DefaultReportURL = strings.TrimRight(o.DefaultReportURL, "/")
}

// Deps 注入的依赖（等价于 Nunu 的 wire 装配，全部是接口）。
type Deps struct {
	Repo    repository.TaskRepository
	Readers reader.Builder
	Writers writer.Builder
	Reports reporter.Builder
	// DB 真实同步模式（契约第 5 节）的连接构造器；nil 时用 dbio 默认实现（真驱动）。
	// 单测可注入假 Dialer，让 real runner 的分支不依赖真实数据库。
	DB     dbio.Dialer
	Logger *log.Logger
}

type taskService struct {
	*Service
	repo    repository.TaskRepository
	readers reader.Builder
	writers writer.Builder
	reports reporter.Builder
	db      dbio.Dialer
	opts    Options

	mu   sync.Mutex
	runs map[string]*runHandle
	now  func() time.Time
}

// runHandle 一个运行中实例的取消句柄。
type runHandle struct {
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func (h *runHandle) markDone() { h.once.Do(func() { close(h.done) }) }

// NewTaskService 构造任务服务。
func NewTaskService(deps Deps, opts Options) (TaskService, error) {
	if deps.Repo == nil {
		return nil, fmt.Errorf("service: TaskRepository 必填")
	}
	if deps.Readers == nil || deps.Writers == nil || deps.Reports == nil {
		return nil, fmt.Errorf("service: Reader/Writer/Reporter Builder 必填")
	}
	opts.withDefaults()
	logger := deps.Logger
	if logger == nil {
		logger = log.DefaultLogger()
	}
	dialer := deps.DB
	if dialer == nil {
		dialer = dbio.NewDialer()
	}
	return &taskService{
		Service: NewService(logger),
		repo:    deps.Repo,
		readers: deps.Readers,
		writers: deps.Writers,
		reports: deps.Reports,
		db:      dialer,
		opts:    opts,
		runs:    make(map[string]*runHandle),
		now:     func() time.Time { return time.Now().UTC().Truncate(time.Millisecond) },
	}, nil
}

var _ TaskService = (*taskService)(nil)

func (s *taskService) Start(ctx context.Context, req *v1.StartTaskRequest) (*v1.StartTaskData, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: 请求体为空", ErrInvalidRequest)
	}
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidRequest, err)
	}
	instanceID := strings.TrimSpace(req.InstanceID)
	reportURL := strings.TrimRight(req.ReportURL, "/")
	if reportURL == "" {
		reportURL = s.opts.DefaultReportURL
	}

	mode := req.ExecMode()
	sourceTable := req.SourceTable
	targetTable := req.TargetTable
	if mode == model.ModeReal {
		// 真实模式下表名以端点里的 table 为准（契约第 5 节），回显字段同步过去
		if strings.TrimSpace(req.Source.Table) != "" {
			sourceTable = req.Source.Table
		}
		if strings.TrimSpace(req.Target.Table) != "" {
			targetTable = req.Target.Table
		}
	}

	task := &model.MockTask{
		InstanceID:        instanceID,
		TaskID:            strings.TrimSpace(req.TaskID),
		TaskName:          req.TaskName,
		Mode:              mode,
		SyncMode:          req.SyncMode,
		BatchSize:         req.BatchSize,
		FailureRate:       req.FailureRate,
		IncrementalColumn: strings.TrimSpace(req.IncrementalColumn),
		PipelineID:        strings.TrimSpace(req.PipelineID),
		SyncObjects:       normalizeSyncObjects(req.SyncObjects),
		SourceTable:       sourceTable,
		TargetTable:       targetTable,
		WriteMode:         req.WriteMode,
		Source: model.Endpoint{
			ID:       req.Source.ID,
			Type:     req.Source.Type,
			Database: req.Source.Database,
			Host:     req.Source.Host,
			Port:     req.Source.Port,
			Username: req.Source.Username,
			Password: req.Source.Password,
			Table:    req.Source.Table,
		},
		Target: model.Endpoint{
			ID:       req.Target.ID,
			Type:     req.Target.Type,
			Database: req.Target.Database,
			Host:     req.Target.Host,
			Port:     req.Target.Port,
			Username: req.Target.Username,
			Password: req.Target.Password,
			Table:    req.Target.Table,
		},
		ReportURL:       reportURL,
		Status:          model.StatusRunning,
		Progress:        0,
		CurrentOffset:   "",
		StartedAt:       s.now(),
		OffsetStart:     strings.TrimSpace(req.OffsetStart),
		CdcPollColumn:   strings.TrimSpace(req.CdcPollColumn),
		PollIntervalSec: req.PollIntervalSec,
		FieldMappings:   normalizeFieldMappings(req.FieldMappings),
	}
	// cdc（数据管道）忽略 totalRows：契约第 2 节第 6 条，管道没有「总量 / 进度」概念
	if task.SyncMode == model.SyncModeCDC {
		task.TotalRows = 0
	} else {
		task.TotalRows = req.TotalRows
	}
	// failureRate 只作用于模拟执行（契约第 2 节第 4 条）；真实模式不做随机失败，
	// 失败一律来自数据库真实错误（契约第 5 节）。
	if !task.IsReal() {
		s.planFailure(task)
	}

	handle := &runHandle{done: make(chan struct{})}
	// 幂等保护：instanceId 已存在（运行中或已终态）一律 409 / 40901
	if err := s.reserve(task, handle); err != nil {
		return nil, err
	}

	runCtx, cancel := context.WithCancel(context.Background())
	handle.cancel = cancel
	if task.IsReal() {
		go s.runReal(runCtx, handle, task)
	} else {
		go s.run(runCtx, handle, task)
	}

	s.logger.Info("task accepted",
		zap.String("instanceId", instanceID),
		zap.String("taskId", task.TaskID),
		zap.String("mode", mode),
		zap.String("syncMode", task.SyncMode),
		zap.Int("batchSize", task.BatchSize),
		zap.Int64("totalRows", task.TotalRows),
		zap.Float64("failureRate", task.FailureRate),
		zap.Int("failAtBatch", task.FailAtBatch),
		zap.String("pipelineId", task.PipelineID),
		zap.Int("syncObjects", len(task.SyncObjects)),
		zap.String("source", task.Source.Label()),
		zap.String("target", task.Target.Label()),
		zap.String("reportUrl", reportURL))

	return &v1.StartTaskData{Accepted: true, InstanceID: instanceID}, nil
}

// normalizeFieldMappings 清洗字段映射：去空白、targetField 缺省沿用 sourceField、保持下发顺序。
func normalizeFieldMappings(mappings []v1.FieldMappingDTO) []model.FieldMapping {
	if len(mappings) == 0 {
		return nil
	}
	out := make([]model.FieldMapping, 0, len(mappings))
	for _, m := range mappings {
		src := strings.TrimSpace(m.SourceField)
		dst := strings.TrimSpace(m.TargetField)
		if dst == "" {
			dst = src
		}
		if src == "" && dst == "" {
			continue
		}
		out = append(out, model.FieldMapping{SourceField: src, TargetField: dst, PrimaryKey: m.PrimaryKey})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeSyncObjects 清洗管道同步对象：去掉空白项、保持下发顺序。
func normalizeSyncObjects(objects []string) []string {
	if len(objects) == 0 {
		return nil
	}
	out := make([]string, 0, len(objects))
	for _, o := range objects {
		if v := strings.TrimSpace(o); v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// reserve 在锁内完成"查重 + 落初始快照 + 登记取消句柄"，保证并发下发同一 instanceId 时只有一份成功。
func (s *taskService) reserve(task *model.MockTask, handle *runHandle) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.runs[task.InstanceID]; ok {
		return fmt.Errorf("%w: instanceId %s 已在运行", ErrDuplicateInstance, task.InstanceID)
	}
	if _, ok := s.repo.Get(context.Background(), task.InstanceID); ok {
		return fmt.Errorf("%w: instanceId %s 已存在", ErrDuplicateInstance, task.InstanceID)
	}
	if err := s.repo.Save(context.Background(), task); err != nil {
		return fmt.Errorf("%w: 写入任务状态失败: %s", ErrInternal, err)
	}
	s.runs[task.InstanceID] = handle
	return nil
}

func (s *taskService) Stop(ctx context.Context, instanceID string) (*v1.StopTaskData, error) {
	id := strings.TrimSpace(instanceID)
	if id == "" {
		return nil, fmt.Errorf("%w: instanceId 必填", ErrInvalidRequest)
	}
	s.mu.Lock()
	handle := s.runs[id]
	s.mu.Unlock()

	if handle == nil {
		if _, ok := s.repo.Get(ctx, id); !ok {
			return nil, fmt.Errorf("%w: instanceId %s 不存在", ErrInstanceNotFound, id)
		}
		// 已是终态：停止指令幂等成功，不再改动状态
		return &v1.StopTaskData{Stopped: true}, nil
	}

	handle.cancel()
	// 等 goroutine 退出（含回报 stopped），避免 Node 拿到响应后读到过期状态
	wait := time.NewTimer(2*s.opts.Tick + s.opts.ReportTimeout)
	defer wait.Stop()
	select {
	case <-handle.done:
	case <-wait.C:
		s.logger.Warn("stop 等待 goroutine 超时", zap.String("instanceId", id))
	}
	return &v1.StopTaskData{Stopped: true}, nil
}

func (s *taskService) List(ctx context.Context, statusFilter string) (*v1.TaskListData, error) {
	filter := strings.TrimSpace(statusFilter)
	items := make([]v1.TaskView, 0)
	for _, t := range s.repo.List(ctx) {
		if filter != "" && t.Status != filter {
			continue
		}
		items = append(items, viewOf(t))
	}
	return &v1.TaskListData{Items: items, Total: len(items)}, nil
}

func (s *taskService) Get(ctx context.Context, instanceID string) (*v1.TaskView, error) {
	id := strings.TrimSpace(instanceID)
	if id == "" {
		return nil, fmt.Errorf("%w: instanceId 必填", ErrInvalidRequest)
	}
	t, ok := s.repo.Get(ctx, id)
	if !ok {
		return nil, fmt.Errorf("%w: instanceId %s 不存在", ErrInstanceNotFound, id)
	}
	view := viewOf(t)
	return &view, nil
}

func (s *taskService) RunningCount(ctx context.Context) int {
	count := 0
	for _, t := range s.repo.List(ctx) {
		if t.Status == model.StatusRunning {
			count++
		}
	}
	return count
}

func (s *taskService) Shutdown(_ context.Context) {
	s.mu.Lock()
	handles := make([]*runHandle, 0, len(s.runs))
	for _, h := range s.runs {
		handles = append(handles, h)
	}
	s.mu.Unlock()
	for _, h := range handles {
		if h.cancel != nil {
			h.cancel()
		}
	}
}

func viewOf(t *model.MockTask) v1.TaskView {
	return v1.TaskView{
		InstanceID:        t.InstanceID,
		TaskID:            t.TaskID,
		TaskName:          t.TaskName,
		Mode:              t.Mode,
		SyncMode:          t.SyncMode,
		Status:            t.Status,
		Progress:          t.Progress,
		TotalRows:         t.TotalRows,
		ReadRows:          t.ReadRows,
		WriteRows:         t.WriteRows,
		BatchSize:         t.BatchSize,
		CurrentOffset:     t.CurrentOffset,
		RateRowsPerSec:    t.RateRowsPerSec,
		FailureRate:       t.FailureRate,
		IncrementalColumn: t.IncrementalColumn,
		SourceTable:       t.SourceTable,
		TargetTable:       t.TargetTable,
		WriteMode:         t.WriteMode,
		Source:            v1.EndpointDTO{ID: t.Source.ID, Type: t.Source.Type, Database: t.Source.Database},
		Target:            v1.EndpointDTO{ID: t.Target.ID, Type: t.Target.Type, Database: t.Target.Database},
		ReportURL:         t.ReportURL,
		StartedAt:         t.StartedAt.UTC(),
		FinishedAt:        t.FinishedAt,
		Message:           t.Message,

		// 数据管道（cdc）字段回显：非 cdc 实例为 "" / nil / 0
		PipelineID:  t.PipelineID,
		SyncObjects: t.SyncObjects,
		ChangeRows:  t.ChangeRows,
		CurrentQps:  t.CurrentQps,
		LagMs:       t.LagMs,
		CdcPosition: t.CdcPosition,
	}
}
