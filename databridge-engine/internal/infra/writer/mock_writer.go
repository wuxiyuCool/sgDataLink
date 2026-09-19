package writer

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"time"
)

// MockBuilder 生成 mockWriter（模拟提交耗时 + 按 0.98~1.0 比例回报写入行数）。
type MockBuilder struct {
	rowDelay time.Duration
	minDelay time.Duration
	maxDelay time.Duration
	// minRatio/maxRatio 写入行数 / 读取行数 的比例区间（契约：0.98 ~ 1.0）
	minRatio float64
	maxRatio float64
}

// NewMockBuilder 构造假数据写入器构建器。
func NewMockBuilder(rowDelay, minDelay, maxDelay time.Duration) *MockBuilder {
	if rowDelay <= 0 {
		rowDelay = 3 * time.Microsecond
	}
	if minDelay < 0 {
		minDelay = 0
	}
	if maxDelay <= minDelay {
		maxDelay = minDelay + 60*time.Millisecond
	}
	return &MockBuilder{rowDelay: rowDelay, minDelay: minDelay, maxDelay: maxDelay, minRatio: 0.98, maxRatio: 1.0}
}

// Build 实现 Builder。
func (b *MockBuilder) Build(_ context.Context, spec Spec) (Writer, error) {
	if spec.BatchSize <= 0 {
		return nil, fmt.Errorf("writer: batchSize 必须大于 0")
	}
	return &mockWriter{spec: spec, cfg: b, rnd: rand.New(rand.NewSource(time.Now().UnixNano() + 7))}, nil
}

// mockWriter 不连接数据库：只模拟提交耗时，并回报略小于读取行的提交行数。
type mockWriter struct {
	spec Spec
	cfg  *MockBuilder
	rnd  *rand.Rand
}

var _ Writer = (*mockWriter)(nil)

func (w *mockWriter) WriteBatch(ctx context.Context, batch []map[string]any) (int64, error) {
	rows := int64(len(batch))
	if rows == 0 {
		return 0, nil
	}
	// 模拟批量提交耗时
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-time.After(w.cfg.latency(rows)):
	}
	// 写入行数 = 读取行数 × 0.98~1.0 随机（契约第 2 条）
	ratio := w.cfg.minRatio + w.rnd.Float64()*(w.cfg.maxRatio-w.cfg.minRatio)
	written := int64(math.Round(float64(rows) * ratio))
	if written > rows {
		written = rows
	}
	return written, nil
}

func (c *MockBuilder) latency(rows int64) time.Duration {
	d := time.Duration(rows) * c.rowDelay
	if d < c.minDelay {
		d = c.minDelay
	}
	if d > c.maxDelay {
		d = c.maxDelay
	}
	return d
}
