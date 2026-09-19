package main

import (
	"context"
	"flag"
	"fmt"

	"databridge-engine/cmd/server/wire"
	"databridge-engine/pkg/config"
	"databridge-engine/pkg/log"
	"go.uber.org/zap"
)

// DataBridge Go 同步引擎（Mock 阶段）入口。
//
// 官方 nunu-layout-advanced 布局：main 只做「加载配置 + wire 装配 + 跑 app」；
// 具体注入哪个 Repository / Reader / Writer / Reporter 实现全部集中在
// cmd/server/wire/wire.go —— 那里就是第二阶段接入 Oracle / PostgreSQL 的唯一替换点。
//
// 运行：
//
//	go run ./cmd/server -conf config/local.yml     # 本地：127.0.0.1:8080
//	go run ./cmd/server -conf config/prod.yml      # 容器：0.0.0.0:8080（Dockerfile 用这份）
//
// 环境变量覆盖：SERVER_PORT / NODE_REPORT_URL / MOCK_TICK_MS（见 pkg/config/env.go）。
// 接口契约：docs/API.md 第 2 节，引擎响应统一 { code, message, data }。
func main() {
	var envConf = flag.String("conf", "config/local.yml", "config path, eg: -conf ./config/local.yml")
	flag.Parse()
	conf := config.NewConfig(*envConf)

	// yml 是主渠道，三个环境变量在加载后覆盖一次即可
	if err := config.ApplyEnvOverrides(conf); err != nil {
		panic(err)
	}

	logger := log.NewLog(conf)

	app, cleanup, err := wire.NewWire(conf, logger)
	if err != nil {
		panic(err)
	}
	defer cleanup()

	logger.Info("databridge-engine starting",
		zap.String("addr", fmt.Sprintf("%s:%d", conf.GetString("http.host"), conf.GetInt("http.port"))),
		zap.String("nodeReportUrl", conf.GetString("engine.node_report_url")),
		zap.Int("mockTickMs", conf.GetInt("engine.mock_tick_ms")),
	)
	if err = app.Run(context.Background()); err != nil {
		panic(err)
	}
}
