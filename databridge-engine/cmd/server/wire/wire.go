//go:build wireinject
// +build wireinject

package wire

import (
	"context"
	"time"

	"databridge-engine/internal/handler"
	"databridge-engine/internal/infra/reader"
	"databridge-engine/internal/infra/reporter"
	"databridge-engine/internal/infra/writer"
	"databridge-engine/internal/repository"
	"databridge-engine/internal/router"
	"databridge-engine/internal/server"
	"databridge-engine/internal/service"
	"databridge-engine/pkg/app"
	"databridge-engine/pkg/log"
	"databridge-engine/pkg/server/http"
	"github.com/google/wire"
	"github.com/spf13/viper"
)

// repositorySet：状态存储。
// Mock 阶段不接任何 DB / redis / mongo（模板里的 NewDB/NewRepository/NewTransaction
// 已随 internal/repository/repository.go 的瘦身一起移除），只有内存实现。
// 第二阶段：换成 repository.NewPostgresTaskRepository 等实现即可。
var repositorySet = wire.NewSet(
	repository.NewMemTaskRepository,
)

// infraSet：数据读写与回报。这里是 mock -> real 的真正替换点，
// 参数与手写版 main.go 的 buildDeps() 保持一致。
// 第二阶段：newReaderBuilder 返回 reader.NewOracleBuilder(dsn)，newWriterBuilder 返回
// writer.NewPostgresBuilder(dsn)；reporter 已是真实 net/http 调用，可保持不变。
var infraSet = wire.NewSet(
	newReaderBuilder,
	newWriterBuilder,
	newReporterBuilder,
)

var serviceSet = wire.NewSet(
	newTaskServiceOptions,
	newTaskServiceDeps,
	service.NewTaskService,
)

var handlerSet = wire.NewSet(
	handler.NewHandler,
	handler.NewEngineHandler,
	newHealthHandler,
)

var serverSet = wire.NewSet(
	server.NewHTTPServer,
)

// newReaderBuilder 假数据读取器：每批 2µs/行的模拟耗时，夹在 1ms ~ 40ms 之间。
func newReaderBuilder() reader.Builder {
	return reader.NewMockBuilder(2*time.Microsecond, time.Millisecond, 40*time.Millisecond)
}

// newWriterBuilder 假提交写入器：写入行数 = 读取行数 × 0.98~1.0（契约第 2 条）。
func newWriterBuilder() writer.Builder {
	return writer.NewMockBuilder(3*time.Microsecond, time.Millisecond, 60*time.Millisecond)
}

func newReporterBuilder(conf *viper.Viper, logger *log.Logger) reporter.Builder {
	return reporter.NewHTTPBuilder(nil, time.Duration(conf.GetInt("engine.report_timeout_ms"))*time.Millisecond, logger)
}

// newTaskServiceOptions 运行参数：yml 的 engine: 节 + 环境变量覆盖后的结果。
func newTaskServiceOptions(conf *viper.Viper) service.Options {
	return service.Options{
		Tick:             time.Duration(conf.GetInt("engine.mock_tick_ms")) * time.Millisecond,
		DefaultReportURL: conf.GetString("engine.node_report_url"),
		ReportTimeout:    time.Duration(conf.GetInt("engine.report_timeout_ms")) * time.Millisecond,
		MaxHistory:       conf.GetInt("engine.max_history"),
	}
}

// newTaskServiceDeps 用例层依赖（全部是接口，第二阶段只换实现，不改 service）。
func newTaskServiceDeps(
	repo repository.TaskRepository,
	readers reader.Builder,
	writers writer.Builder,
	reports reporter.Builder,
	logger *log.Logger,
) service.Deps {
	return service.Deps{
		Repo:    repo,
		Readers: readers,
		Writers: writers,
		Reports: reports,
		Logger:  logger,
	}
}

// newHealthHandler /health 需要 tick 配置与「运行中实例数」回调。
func newHealthHandler(
	h *handler.Handler,
	conf *viper.Viper,
	taskService service.TaskService,
) *handler.HealthHandler {
	return handler.NewHealthHandler(h, conf.GetInt("engine.mock_tick_ms"), func() int {
		return taskService.RunningCount(context.Background())
	})
}

// newApp 组装 app；cleanup 里取消仍在运行的模拟任务（进程退出前收尾）。
func newApp(
	httpServer *http.Server,
	taskService service.TaskService,
) (*app.App, func(), error) {
	return app.NewApp(
			app.WithServer(httpServer),
			app.WithName("databridge-engine"),
		), func() {
			taskService.Shutdown(context.Background())
		}, nil
}

func NewWire(*viper.Viper, *log.Logger) (*app.App, func(), error) {
	panic(wire.Build(
		repositorySet,
		infraSet,
		serviceSet,
		handlerSet,
		serverSet,
		wire.Struct(new(router.RouterDeps), "*"),
		newApp,
	))
}
