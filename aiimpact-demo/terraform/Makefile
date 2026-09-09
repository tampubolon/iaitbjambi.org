# Build the Lambda artifacts Terraform consumes.
#
#   make build      compile + package both functions
#   make test       go test ./...
#   make plan       build, then terraform plan
#   make apply      build, then terraform apply
#
# arm64 targets Graviton: cheaper per GB-second and the native target for Go.

BUILD   := .build
GOFLAGS := -ldflags=-s\ -w -trimpath
export GOOS         := linux
export GOARCH       := arm64
export CGO_ENABLED  := 0

.PHONY: all build test vet fmt clean plan apply

all: build

test:
	cd src && GOOS= GOARCH= go test ./...

vet:
	cd src && GOOS= GOARCH= go vet ./...

fmt:
	cd src && gofmt -l -w .
	terraform fmt -recursive

build: test
	@mkdir -p $(BUILD)
	cd src && go build $(GOFLAGS) -o ../$(BUILD)/api-bootstrap    ./cmd/api
	cd src && go build $(GOFLAGS) -o ../$(BUILD)/worker-bootstrap ./cmd/worker
	./scripts/package.py $(BUILD)/api-bootstrap    $(BUILD)/api.zip
	./scripts/package.py $(BUILD)/worker-bootstrap $(BUILD)/worker.zip

plan: build
	terraform plan

apply: build
	terraform apply

clean:
	rm -rf $(BUILD)
