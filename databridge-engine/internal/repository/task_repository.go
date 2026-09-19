package repository

import (
	"context"

	"databridge-engine/internal/model"
)

// TaskRepository 引擎运行实例的状态存储接口（docs/API.md 第 2 节「第二阶段替换点」）。
//
// 语义约定：
//   - Save 为 upsert（按 InstanceID）；
//   - Get/List 返回的对象必须是可安全只读使用的（内存实现返回值拷贝），
//     这样 runner goroutine 与 handler 不会共享同一份可变状态。
//
// 第二阶段可替换为 Redis / PostgreSQL 等实现，service 层不需要改动。
type TaskRepository interface {
	Save(ctx context.Context, t *model.MockTask) error
	Get(ctx context.Context, instanceID string) (*model.MockTask, bool)
	List(ctx context.Context) []*model.MockTask
	Remove(ctx context.Context, instanceID string) error
}
