// Package dbio 是 docs/API.md 第 5 节「引擎真实同步模式」的数据访问层。
//
// 与 internal/infra/reader、internal/infra/writer 里的 mock 实现不同，本包面向真实数据库：
//
//	Connector  打开/关闭源库与目标库两个 *sql.DB 连接池（mysql -> go-sql-driver/mysql，
//	           oracle -> go-ora/v2，注册名 oracle，纯 Go 免 Instant Client）
//	Reader     源库读取：Count / CountAfter / FetchBatch（返回 []map[string]any + 列序）
//	Writer     目标库写入：EnsureWritable（overwrite 先清表）/ WriteBatch（insert / upsert）
//
// 方言差异（引用符、分页语句、批插语法、清空语句、元数据视图）全部收敛在
// mysqlDialect / oracleDialect 两个未导出实现里，上层只见 dialect 接口。
//
// 安全红线（契约第 5 节）：
//   - 标识符一律走方言转义（mysql 反引号、oracle 双引号），且优先用数据字典里的真实大小写；
//   - 值一律走绑定参数，绝不把字面量拼进 SQL 文本；
//   - Endpoint 携带明文密码，只用于建连，不进日志、不进回报（见 Endpoint.Label 与 redact）。
package dbio

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ErrCancelled 任务上下文被取消（stop 指令）导致的读写出错：上层据此回报 stopped 而非 failed。
var ErrCancelled = errors.New("dbio: 操作已取消")

// wrapCtx 取消类错误保持哨兵可辨（%w 包装），其余交给调用方处理。
func wrapCtx(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %s", ErrCancelled, err.Error())
	}
	return nil
}

// 支持的真实库类型（契约第 5 节：mysql / oracle；postgresql 留待后续）。
const (
	TypeMySQL  = "mysql"
	TypeOracle = "oracle"
)

// 冲突策略（契约第 0 节 writeMode 枚举）。
const (
	WriteModeInsert    = "insert"
	WriteModeUpsert    = "upsert"
	WriteModeOverwrite = "overwrite"
)

// Endpoint 一个真实库端点的连接信息 + 表名。
// Password 为明文（仅内网进程间传输），除建连外不参与任何日志/回报/错误消息。
type Endpoint struct {
	Type     string // mysql | oracle
	Host     string
	Port     int
	Database string // mysql: 库名；oracle: service name（或 SID）
	Username string
	Password string
	Table    string // 表名，可用 "schema.table" 限定
}

// DBType 归一化后的库类型（小写、去空白）。
func (e Endpoint) DBType() string {
	return strings.ToLower(strings.TrimSpace(e.Type))
}

// Validate 校验真实模式所需的最小字段集。
func (e Endpoint) Validate() error {
	switch e.DBType() {
	case TypeMySQL, TypeOracle:
	default:
		return fmt.Errorf("dbio: 不支持的数据库类型 %q（真实模式支持 mysql / oracle）", e.Type)
	}
	if strings.TrimSpace(e.Host) == "" {
		return fmt.Errorf("dbio: %s.host 必填", e.DBType())
	}
	if e.Port <= 0 || e.Port > 65535 {
		return fmt.Errorf("dbio: %s.port 不合法: %d", e.DBType(), e.Port)
	}
	if strings.TrimSpace(e.Username) == "" {
		return fmt.Errorf("dbio: %s.username 必填", e.DBType())
	}
	if strings.TrimSpace(e.Table) == "" {
		return fmt.Errorf("dbio: %s.table 必填", e.DBType())
	}
	if e.DBType() == TypeMySQL && strings.TrimSpace(e.Database) == "" {
		return fmt.Errorf("dbio: mysql.database（库名）必填")
	}
	if e.DBType() == TypeOracle && strings.TrimSpace(e.Database) == "" {
		return fmt.Errorf("dbio: oracle.database（service name 或 SID）必填")
	}
	return nil
}

// Label 日志用的安全标识：不含密码。
func (e Endpoint) Label() string {
	table := strings.TrimSpace(e.Table)
	if table == "" {
		table = "-"
	}
	return fmt.Sprintf("%s:%d/%s/%s", e.Host, e.Port, strings.TrimSpace(e.Database), table)
}

// defaultSchema 未显式限定表所属库/owner 时的归属：
// mysql 用连接库名，oracle 用登录用户名（数据字典里的 owner 恒为大写）。
func (e Endpoint) defaultSchema() string {
	if e.DBType() == TypeOracle {
		return strings.ToUpper(strings.TrimSpace(e.Username))
	}
	return strings.TrimSpace(e.Database)
}

// splitTable 拆出 schema/owner 与表名（table 未限定则 schema 返回空，由调用方兜底）。
func splitTable(name string) (schema, table string) {
	name = strings.TrimSpace(name)
	if i := strings.Index(name, "."); i >= 0 {
		return strings.TrimSpace(name[:i]), strings.TrimSpace(name[i+1:])
	}
	return "", name
}

// schemaOf 解析表所属 schema/owner（含兜底）。
func (e Endpoint) schemaOf() string {
	schema, _ := splitTable(e.Table)
	if schema != "" {
		return schema
	}
	return e.defaultSchema()
}

// tableOnly 去掉 schema 前缀后的表名。
func (e Endpoint) tableOnly() string {
	_, table := splitTable(e.Table)
	return table
}

// ValueKind 列的粗粒度类型类别，用于把持久化的位点字符串还原成绑定值。
type ValueKind int

const (
	KindText ValueKind = iota
	KindNumber
	KindTime
)

func (k ValueKind) String() string {
	switch k {
	case KindNumber:
		return "number"
	case KindTime:
		return "time"
	default:
		return "text"
	}
}

// timeLayouts 位点字符串可接受的时间格式（RFC3339(Nano) 优先，兼容库里常见的书写格式）。
var timeLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"20060102150405",
}

// ParsePosition 把持久化位点（Node 下发的 offsetStart / cdcPosition）还原成绑定值。
// kind 来自数据字典：时间列 -> time.Time，数值列 -> int64/float64，其余 -> 原字符串。
func ParsePosition(kind ValueKind, raw string) (any, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return nil, nil
	}
	switch kind {
	case KindNumber:
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return i, nil
		}
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, nil
		}
		return nil, fmt.Errorf("dbio: 位点 %q 不是合法数值", raw)
	case KindTime:
		for _, layout := range timeLayouts {
			if t, err := time.Parse(layout, v); err == nil {
				return t, nil
			}
		}
		return nil, fmt.Errorf("dbio: 位点 %q 不是合法时间（期望 RFC3339 或 'YYYY-MM-DD HH:MM:SS'）", raw)
	default:
		return v, nil
	}
}

// FormatPosition 把列值字符串化为位点（时间保留原始时区偏移，保证下一轮绑定时墙钟不漂移）。
func FormatPosition(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case time.Time:
		return t.Format(time.RFC3339Nano)
	case []byte:
		return string(t)
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// redact 兜底擦除错误消息里可能出现的密码（我们自己从不拼接，但驱动可能回显连接串）。
func redact(msg, password string) string {
	msg = strings.TrimSpace(msg)
	if p := strings.TrimSpace(password); p != "" && len(p) >= 3 {
		msg = strings.ReplaceAll(msg, p, "***")
	}
	return msg
}

// truncateMessage 按契约第 5 节把数据库原始错误截断到 500 字（回报 message 用）。
func TruncateMessage(msg string) string {
	msg = strings.TrimSpace(strings.ReplaceAll(msg, "\n", " "))
	if len([]rune(msg)) <= 500 {
		return msg
	}
	r := []rune(msg)
	return string(r[:500])
}
