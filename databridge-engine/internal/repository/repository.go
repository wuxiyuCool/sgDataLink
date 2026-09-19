// Package repository 是引擎运行实例的状态存储层。
//
// Mock 阶段不连接任何数据库 / redis / mongo，因此模板时代的 NewDB / NewRedis /
// NewMongo 等 Provider 已全部移除，本包只剩「空 ProviderSet」：
// 唯一的实现是同包下的 memRepo（map + sync.RWMutex），装配在
// cmd/server/wire/wire.go 完成——
//
//	// Mock 阶段的 repositorySet（DB/redis/mongo Provider 已清空，仅内存实现）
//	var repositorySet = wire.NewSet(repository.NewMemTaskRepository)
//
// 第二阶段接入 PostgreSQL / Redis 时，在本包新增 xxx_repo.go 实现 TaskRepository
// 接口并替换 wire.go 里的那一条 Provider，service 层不需要改动。
package repository
