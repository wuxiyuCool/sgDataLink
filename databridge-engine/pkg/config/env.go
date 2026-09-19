package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/viper"
)

// 环境变量名（docs/API.md 第 4 节：databridge-engine 的关键环境变量）。
const (
	EnvServerPort    = "SERVER_PORT"
	EnvNodeReportURL = "NODE_REPORT_URL"
	EnvMockTickMS    = "MOCK_TICK_MS"
)

// 配置缺省值：yml 里没写、环境变量也没设时使用（本地联调场景，Node 管理端跑在 3001）。
const (
	DefaultServerPort      = 8080
	DefaultNodeReportURL   = "http://127.0.0.1:3001/api/v1/engine"
	DefaultMockTickMS      = 1000
	DefaultReportTimeoutMS = 3000
	DefaultMaxHistory      = 200
)

// ApplyEnvOverrides 在 yml 主渠道之上叠加环境变量覆盖，并把缺省值写回 viper，
// 使后续所有 Provider 只需读 conf.Get*（"代码最小改动：config 加载后覆盖一次"）：
//
//	SERVER_PORT      -> http.port               （默认 8080）
//	NODE_REPORT_URL  -> engine.node_report_url  （默认 http://127.0.0.1:3001/api/v1/engine）
//	MOCK_TICK_MS     -> engine.mock_tick_ms     （默认 1000，最小 50）
//
// 另外补齐 engine.report_timeout_ms / engine.max_history 的默认值（仅 yml 可配）。
func ApplyEnvOverrides(conf *viper.Viper) error {
	// http.port
	port := conf.GetInt("http.port")
	if port <= 0 {
		port = DefaultServerPort
	}
	raw, err := envInt(EnvServerPort, port)
	if err != nil {
		return err
	}
	conf.Set("http.port", raw)

	// engine.node_report_url
	reportURL := strings.TrimSpace(conf.GetString("engine.node_report_url"))
	if reportURL == "" {
		reportURL = DefaultNodeReportURL
	}
	if v := strings.TrimSpace(os.Getenv(EnvNodeReportURL)); v != "" {
		reportURL = v
	}
	reportURL = strings.TrimRight(reportURL, "/")
	if reportURL == "" {
		return fmt.Errorf("%s 不能为空", EnvNodeReportURL)
	}
	conf.Set("engine.node_report_url", reportURL)

	// engine.mock_tick_ms
	tick := conf.GetInt("engine.mock_tick_ms")
	if tick <= 0 {
		tick = DefaultMockTickMS
	}
	tick, err = envInt(EnvMockTickMS, tick)
	if err != nil {
		return err
	}
	if tick < 50 {
		return fmt.Errorf("%s / engine.mock_tick_ms 不能小于 50 毫秒，当前为 %d", EnvMockTickMS, tick)
	}
	conf.Set("engine.mock_tick_ms", tick)

	// 其余可选运行参数（仅 yml 配置，给出默认值）
	if conf.GetInt("engine.report_timeout_ms") <= 0 {
		conf.Set("engine.report_timeout_ms", DefaultReportTimeoutMS)
	}
	if conf.GetInt("engine.max_history") <= 0 {
		conf.Set("engine.max_history", DefaultMaxHistory)
	}
	return nil
}

func envInt(key string, def int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s 必须是整数，当前为 %q", key, raw)
	}
	return v, nil
}
