package reader

import (
	"context"
	"fmt"
	"math/rand"
	"time"
)

// MockBuilder 生成 mockReader（假数据 + 模拟延迟）。
type MockBuilder struct {
	// rowDelay 单行模拟耗时，用于估算每批延迟
	rowDelay time.Duration
	// minDelay/maxDelay 每批延迟的上下限，避免 tick 被拖垮
	minDelay time.Duration
	maxDelay time.Duration
}

// NewMockBuilder 构造假数据读取器构建器。
func NewMockBuilder(rowDelay, minDelay, maxDelay time.Duration) *MockBuilder {
	if rowDelay <= 0 {
		rowDelay = 2 * time.Microsecond
	}
	if minDelay < 0 {
		minDelay = 0
	}
	if maxDelay <= minDelay {
		maxDelay = minDelay + 50*time.Millisecond
	}
	return &MockBuilder{rowDelay: rowDelay, minDelay: minDelay, maxDelay: maxDelay}
}

// Build 实现 Builder。
func (b *MockBuilder) Build(_ context.Context, spec Spec) (Reader, error) {
	if spec.BatchSize <= 0 {
		return nil, fmt.Errorf("reader: batchSize 必须大于 0")
	}
	rowsLeft := spec.TotalRows
	if spec.Unbounded {
		// cdc 日志捕获：源端无终点，rowsLeft = -1 表示不限剩余行数
		rowsLeft = -1
	}
	return &mockReader{
		spec:     spec,
		rowsLeft: rowsLeft,
		nextID:   1,
		rnd:      rand.New(rand.NewSource(time.Now().UnixNano())),
		cfg:      b,
	}, nil
}

// mockReader 不连接数据库：按 batchSize 生成结构稳定的假数据行，并用 time.Sleep 模拟读耗时。
type mockReader struct {
	spec     Spec
	rowsLeft int64 // <0 表示无终点（cdc 日志捕获模式）
	nextID   int64
	rnd      *rand.Rand
	cfg      *MockBuilder
}

var _ Reader = (*mockReader)(nil)

// TotalRows 源表总行数；cdc 日志捕获模式没有总量，返回 0。
func (r *mockReader) TotalRows(_ context.Context) (int64, error) {
	if r.spec.Unbounded {
		return 0, nil
	}
	return r.spec.TotalRows, nil
}

func (r *mockReader) ReadBatch(ctx context.Context, batch []map[string]any) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	n := int64(0)
	for i := range batch {
		if r.rowsLeft == 0 {
			break
		}
		batch[i] = r.nextRow()
		if r.rowsLeft > 0 {
			r.rowsLeft--
		}
		n++
	}
	if n == 0 {
		return 0, nil
	}
	// 模拟读取耗时（有上限，保证 tick 节奏）
	select {
	case <-ctx.Done():
		return n, ctx.Err()
	case <-time.After(r.cfg.latency(n)):
	}
	return n, nil
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

// nextRow 生成一行假数据，字段风格贴近 Oracle -> MySQL 的示例表。
func (r *mockReader) nextRow() map[string]any {
	id := r.nextID
	r.nextID++
	now := time.Now().UTC()
	return map[string]any{
		"ID":          id,
		"ORDER_NO":    fmt.Sprintf("NO%010d", id),
		"CUSTOMER":    fmt.Sprintf("customer_%04d", id%997),
		"AMOUNT":      float64(int64(r.rnd.Intn(1000000))) / 100,
		"STATUS":      []string{"NEW", "PAID", "SHIPPED", "CLOSED"}[id%4],
		"UPDATE_TIME": now.Format(time.RFC3339),
		"ROWID":       fmt.Sprintf("AAAY%04d%06d", id%1000, id%1000000),
	}
}
