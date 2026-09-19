package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	v1 "databridge-engine/api/v1"
	"databridge-engine/pkg/log"
	"go.uber.org/zap"
)

// HTTPBuilder 创建 httpReporter（真实 net/http 调用，指向 Node mock）。
type HTTPBuilder struct {
	client  *http.Client
	timeout time.Duration
	log     *log.Logger
}

// NewHTTPBuilder 构造回报器构建器；client 可为 nil（内部按 timeout 生成）。
func NewHTTPBuilder(client *http.Client, timeout time.Duration, logger *log.Logger) *HTTPBuilder {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	if logger == nil {
		logger = log.DefaultLogger()
	}
	return &HTTPBuilder{client: client, timeout: timeout, log: logger}
}

// Build 实现 Builder；baseURL 为空时返回 no-op 回报器（只打本地日志）。
func (b *HTTPBuilder) Build(baseURL string) Reporter {
	if baseURL == "" {
		return &nopReporter{log: b.log}
	}
	return &httpReporter{baseURL: baseURL, client: b.client, timeout: b.timeout, log: b.log}
}

type httpReporter struct {
	baseURL string
	client  *http.Client
	timeout time.Duration
	log     *log.Logger
}

var _ Reporter = (*httpReporter)(nil)

func (r *httpReporter) Report(ctx context.Context, report *v1.ProgressReport) error {
	return r.post(ctx, "/report", report)
}

func (r *httpReporter) ReportLogs(ctx context.Context, instanceID string, logs []v1.LogItem) error {
	if len(logs) == 0 {
		return nil
	}
	return r.post(ctx, "/logs", v1.LogsPayload{InstanceID: instanceID, Logs: logs})
}

func (r *httpReporter) post(ctx context.Context, path string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("reporter: 序列化请求失败: %w", err)
	}
	if r.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, r.timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("reporter: 构造请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("reporter: POST %s%s 失败: %w", r.baseURL, path, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("reporter: POST %s%s 返回 HTTP %d", r.baseURL, path, resp.StatusCode)
	}
	// Node 侧统一结构 { code, message, result }，code != 0 视为业务失败
	var out struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if len(raw) > 0 && json.Unmarshal(raw, &out) == nil && out.Code != 0 {
		return fmt.Errorf("reporter: POST %s%s 业务失败 code=%d message=%s", r.baseURL, path, out.Code, out.Message)
	}
	return nil
}

// nopReporter 未配置 reportUrl 时使用：只写本地结构化日志。
type nopReporter struct{ log *log.Logger }

func (n *nopReporter) Report(_ context.Context, r *v1.ProgressReport) error {
	n.log.Info("progress(mock, 未回报)",
		zap.String("instanceId", r.InstanceID),
		zap.String("status", r.Status),
		zap.Int("progress", r.Progress),
		zap.Int64("readRows", r.ReadRows),
		zap.Int64("writeRows", r.WriteRows))
	return nil
}

func (n *nopReporter) ReportLogs(_ context.Context, instanceID string, logs []v1.LogItem) error {
	for _, l := range logs {
		n.log.Info("task log(mock, 未回报)",
			zap.String("instanceId", instanceID), zap.String("level", l.Level), zap.String("message", l.Message))
	}
	return nil
}
