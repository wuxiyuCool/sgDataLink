package dbio

import (
	"context"
	"database/sql"
	"fmt"
)

// FieldMapping 字段映射（契约 1.2 fieldMappings 的真实模式最小子集）。
type FieldMapping struct {
	SourceField string
	TargetField string
	PrimaryKey  bool
}

// Connector 一次真实同步的库连接持有者：源库 + 目标库两个 *sql.DB 连接池。
// 使用方必须成对调用 Dial / Close（Close 幂等）。
type Connector struct {
	source    *sql.DB
	target    *sql.DB
	sourceEP  Endpoint
	targetEP  Endpoint
	sourceDIA dialect
	targetDIA dialect
}

// Dialer 打开连接池的抽象：service 层只依赖接口，单元测试可注入假实现。
type Dialer interface {
	Dial(ctx context.Context, source, target Endpoint) (*Connector, error)
}

// defaultDialer 真实实现，直接委托包级 Dial。
type defaultDialer struct{}

// NewDialer 返回生产用 Dialer。
func NewDialer() Dialer { return defaultDialer{} }

func (defaultDialer) Dial(ctx context.Context, source, target Endpoint) (*Connector, error) {
	return Dial(ctx, source, target)
}

// Dial 校验两端配置、按方言打开连接池并各做一次握手。
// 任一失败即关闭已打开的一侧，错误消息已去除口令。
func Dial(ctx context.Context, source, target Endpoint) (*Connector, error) {
	srcDialect, err := newDialect(source)
	if err != nil {
		return nil, err
	}
	tgtDialect, err := newDialect(target)
	if err != nil {
		return nil, err
	}
	if err := source.Validate(); err != nil {
		return nil, fmt.Errorf("源端: %w", err)
	}
	if err := target.Validate(); err != nil {
		return nil, fmt.Errorf("目标端: %w", err)
	}

	c := &Connector{
		sourceEP:  source,
		targetEP:  target,
		sourceDIA: srcDialect,
		targetDIA: tgtDialect,
	}
	if c.source, err = openPooled(ctx, source, srcDialect); err != nil {
		return nil, fmt.Errorf("源库 %s: %w", source.Label(), err)
	}
	if c.target, err = openPooled(ctx, target, tgtDialect); err != nil {
		_ = c.source.Close()
		c.source = nil
		return nil, fmt.Errorf("目标库 %s: %w", target.Label(), err)
	}
	return c, nil
}

// Close 关闭两侧连接池（nil 安全）。
func (c *Connector) Close() error {
	if c == nil {
		return nil
	}
	var firstErr error
	if c.source != nil {
		if err := c.source.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("关闭源库失败: %s", redact(err.Error(), c.sourceEP.Password))
		}
		c.source = nil
	}
	if c.target != nil {
		if err := c.target.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("关闭目标库失败: %s", redact(err.Error(), c.targetEP.Password))
		}
		c.target = nil
	}
	return firstErr
}

// SourceEndpoint 源端配置（已校验，含明文口令，仅可用于日志的 Label 视图）。
func (c *Connector) SourceEndpoint() Endpoint { return c.sourceEP }

// TargetEndpoint 目标端配置。
func (c *Connector) TargetEndpoint() Endpoint { return c.targetEP }

// SourceDB 暴露源库连接，供上层做自定义只读探测（当前未使用，保留扩展点）。
func (c *Connector) SourceDB() *sql.DB { return c.source }

// TargetDB 暴露目标库连接。
func (c *Connector) TargetDB() *sql.DB { return c.target }
