.PHONY: init tidy wire run build vet test docker clean

# 本地开发工具（wire 用于重新生成 cmd/server/wire/wire_gen.go）
init:
	go install github.com/google/wire/cmd/wire@latest

tidy:
	go mod tidy

# 改了 Provider / 装配后执行（internal/{handler,service,repository,infra,router,server} 变更不需要）
wire:
	go run github.com/google/wire/cmd/wire@latest gen ./cmd/server/wire

# 本地跑：127.0.0.1:8080，回报地址取 config/local.yml 的 engine.node_report_url
run:
	go run ./cmd/server -conf config/local.yml

build:
	go build -trimpath -ldflags="-s -w" -o ./bin/databridge-engine ./cmd/server

vet:
	go vet ./...

test:
	go test ./...

# 仓库根还有 docker-compose.yaml 一键起三服务
docker:
	docker build -t databridge/engine:mock .

clean:
	rm -rf ./bin ./storage/logs
