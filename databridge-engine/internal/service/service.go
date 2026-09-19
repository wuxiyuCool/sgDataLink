package service

import (
	"databridge-engine/pkg/log"
)

// Service 用例层基类（Nunu 布局约定）。
//
// Mock 阶段它只持有结构化日志器：模板里的 sid / jwt / repository.Transaction（GORM 事务）
// 已随 internal/repository 的 DB 接线一起删除，第二阶段接入真实存储时按需加回。
type Service struct {
	logger *log.Logger
}

func NewService(
	logger *log.Logger,
) *Service {
	return &Service{
		logger: logger,
	}
}
