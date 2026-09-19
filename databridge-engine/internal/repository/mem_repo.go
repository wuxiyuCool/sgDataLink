package repository

import (
	"context"
	"errors"
	"sort"
	"sync"

	"databridge-engine/internal/model"
)

// ErrEmptyInstanceID 空实例 ID。
var ErrEmptyInstanceID = errors.New("instanceId 不能为空")

// memRepo 纯内存实现：map + sync.RWMutex，Mock 阶段不落任何数据库。
type memRepo struct {
	mu    sync.RWMutex
	tasks map[string]*model.MockTask
}

// NewMemTaskRepository 返回内存状态存储。
func NewMemTaskRepository() TaskRepository {
	return &memRepo{tasks: make(map[string]*model.MockTask)}
}

var _ TaskRepository = (*memRepo)(nil)

func (r *memRepo) Save(_ context.Context, t *model.MockTask) error {
	if t == nil {
		return ErrEmptyInstanceID
	}
	if t.InstanceID == "" {
		return ErrEmptyInstanceID
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tasks == nil {
		r.tasks = make(map[string]*model.MockTask)
	}
	// 存副本：调用方之后仍可继续修改自己持有的对象
	r.tasks[t.InstanceID] = t.Clone()
	return nil
}

func (r *memRepo) Get(_ context.Context, instanceID string) (*model.MockTask, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tasks[instanceID]
	if !ok {
		return nil, false
	}
	return t.Clone(), true
}

func (r *memRepo) List(_ context.Context) []*model.MockTask {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*model.MockTask, 0, len(r.tasks))
	for _, t := range r.tasks {
		out = append(out, t.Clone())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].InstanceID < out[j].InstanceID
		}
		return out[i].StartedAt.After(out[j].StartedAt)
	})
	return out
}

func (r *memRepo) Remove(_ context.Context, instanceID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tasks, instanceID)
	return nil
}
