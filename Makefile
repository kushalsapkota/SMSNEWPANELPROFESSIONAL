# SMS gateway: top-level developer / CI entry points.
#   make help
# Every test target uses its own database / Redis DB index (overridable below), so suites never
# share state. The DB-backed targets need root (db/reset-db.sh runs psql as the postgres user).

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
REDIS_PORT  ?= 6399
PGPORT      ?= 5432

# Test fixtures (CONTRACTS §1 defaults).
SCHEMA_TEST_DB     ?= sms_schema_test
MIGRATE_TEST_DB    ?= sms_migrate_test
LUA_TEST_REDIS_DB  ?= 15
GO_TEST_DB_CORE    ?= sms_core
GO_TEST_DB_FLOW    ?= sms_flow
GO_TEST_REDIS_CORE ?= 1
GO_TEST_REDIS_FLOW ?= 2
GO_TEST_FLAGS      ?= -count=1

# Images.
IMAGE_PREFIX ?= smsgw
IMAGE_TAG    ?= latest
WEB_API_URL  ?= http://api:3000
COMPOSE      ?= docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env

ENGINE_CMDS := engine smsc-sim smpp-cli

.PHONY: help dev-up dev-down dev-demo dev-purge \
        build build-engine build-api build-web \
        test test-deploy test-db test-migrate test-lua test-go test-api test-web \
        docker-build compose-up compose-down migrate partitions

help: ## list targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------------------------------------------------
# Native dev stack (no Docker)
# --------------------------------------------------------------------------------------------
dev-up: ## fresh sms_dev DB, build, start smsc-sim + engine + api + web (deploy/.run/)
	@deploy/dev-up.sh

dev-down: ## stop everything dev-up started
	@deploy/dev-down.sh

dev-purge: ## stop and drop the dev DB / Redis data / logs
	@deploy/dev-down.sh --purge

dev-demo: ## (stack running) provision demo tenants if needed + HTTP and SMPP round trip
	@deploy/dev-demo.sh

# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------
build: build-engine build-api build-web ## build engine binaries, api dist/, web .next/

build-engine: ## static Go binaries into engine/bin/
	@cd engine && for c in $(ENGINE_CMDS); do \
	  CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o bin/$$c ./cmd/$$c; done
	@echo "built: $(addprefix engine/bin/,$(ENGINE_CMDS))"

build-api: ## NestJS → api/dist
	@cd api && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build

build-web: ## Next.js production build (API_URL defaults to http://localhost:3000)
	@cd web && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && NEXT_TELEMETRY_DISABLED=1 npm run build

# --------------------------------------------------------------------------------------------
# Tests: `make test` runs every suite and fails if any of them fails
# --------------------------------------------------------------------------------------------
test: ## all suites: deploy checks, DB schema, migrations, Lua, Go -race, api, web
	@failed=(); \
	for t in test-deploy test-db test-migrate test-lua test-go test-api test-web; do \
	  echo; echo "==================== $$t ===================="; \
	  $(MAKE) $$t || failed+=("$$t"); \
	done; echo; \
	if (( $${#failed[@]} )); then echo "FAILED: $${failed[*]}"; exit 1; fi; \
	echo "ALL SUITES PASSED"

test-deploy: ## compose/env/Dockerfile/script static checks (no Docker needed)
	@python3 deploy/validate.py

test-db: ## schema assertions (db/tests/schema_test.sql) on a fresh reset-db.sh DB
	@db/reset-db.sh $(SCHEMA_TEST_DB) >/dev/null
	@out="$$(su postgres -c 'psql -X -v ON_ERROR_STOP=1 -d $(SCHEMA_TEST_DB)' < db/tests/schema_test.sql 2>&1)" \
	  || { echo "$$out" | tail -n 20; exit 1; }; \
	echo "$$out" | grep -q 'ALL SCHEMA TESTS PASSED' || { echo "$$out" | tail -n 20; exit 1; }; \
	echo "$$out" | grep -c '^NOTICE:  ok' | xargs printf 'test-db: %s ok assertions, ALL SCHEMA TESTS PASSED\n'

test-migrate: ## deploy/migrate.sh on an empty DB (twice: idempotent) + schema test on the result
	@su postgres -c "psql -X -qAt -c 'DROP DATABASE IF EXISTS $(MIGRATE_TEST_DB) WITH (FORCE)' -c 'CREATE DATABASE $(MIGRATE_TEST_DB)'" >/dev/null
	@MIGRATE_AS_POSTGRES=1 PGDATABASE=$(MIGRATE_TEST_DB) deploy/migrate.sh
	@MIGRATE_AS_POSTGRES=1 PGDATABASE=$(MIGRATE_TEST_DB) deploy/migrate.sh 2>&1 | grep -q 'up to date' \
	  || { echo "test-migrate: second run was not a no-op"; exit 1; }
	@n="$$(su postgres -c "psql -X -qAt -d $(MIGRATE_TEST_DB) -c 'SELECT count(*) FROM schema_migrations'")"; \
	  want="$$(ls db/migrations/*.sql | wc -l)"; [[ "$$n" == "$$want" ]] \
	  || { echo "test-migrate: schema_migrations has $$n rows, expected $$want"; exit 1; }
	@su postgres -c 'psql -X -v ON_ERROR_STOP=1 -d $(MIGRATE_TEST_DB)' < db/tests/schema_test.sql 2>&1 | grep -q 'ALL SCHEMA TESTS PASSED' \
	  || { echo "test-migrate: schema test failed on the migrate.sh-built DB"; exit 1; }
	@su postgres -c "psql -X -qAt -c 'DROP DATABASE IF EXISTS $(MIGRATE_TEST_DB) WITH (FORCE)'" >/dev/null
	@echo "test-migrate: migrate.sh applied $$(ls db/migrations/*.sql | wc -l) files, re-run was a no-op, schema test passed"

test-lua: ## balance Lua scripts (flushes Redis DB $(LUA_TEST_REDIS_DB)) + engine copies identical
	@REDIS_PORT=$(REDIS_PORT) REDIS_DB=$(LUA_TEST_REDIS_DB) redis/tests/lua_test.sh | tail -n 3
	@diff -r redis/lua engine/internal/billing/lua >/dev/null \
	  || { echo "test-lua: engine/internal/billing/lua differs from canonical redis/lua"; diff -r redis/lua engine/internal/billing/lua; exit 1; }
	@echo "test-lua: engine embedded Lua matches redis/lua"

test-go: ## engine: go vet + go test -race ./... (fresh $(GO_TEST_DB_CORE) / $(GO_TEST_DB_FLOW))
	@cd engine && go vet ./...
	@GO_TEST_DB_CORE=$(GO_TEST_DB_CORE) GO_TEST_DB_FLOW=$(GO_TEST_DB_FLOW) \
	  GO_TEST_REDIS_CORE=$(GO_TEST_REDIS_CORE) GO_TEST_REDIS_FLOW=$(GO_TEST_REDIS_FLOW) \
	  GO_TEST_FLAGS="$(GO_TEST_FLAGS)" REDIS_PORT=$(REDIS_PORT) PGPORT=$(PGPORT) deploy/test-go.sh

test-api: ## api: tsc lint + jest e2e (DB sms_api2, Redis DB 5, per api/test/env.ts)
	@cd api && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run lint && npm test

test-web: ## web: eslint + tsc + vitest + production build
	@cd web && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } \
	  && npm run lint && npm run typecheck && npm test && NEXT_TELEMETRY_DISABLED=1 npm run build

# --------------------------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------------------------
docker-build: ## build the engine, api and web images (needs Docker with BuildKit)
	@command -v docker >/dev/null || { echo "docker-build: docker is not installed"; exit 1; }
	DOCKER_BUILDKIT=1 docker build -f deploy/engine.Dockerfile -t $(IMAGE_PREFIX)/engine:$(IMAGE_TAG) .
	DOCKER_BUILDKIT=1 docker build -f deploy/api.Dockerfile    -t $(IMAGE_PREFIX)/api:$(IMAGE_TAG) .
	DOCKER_BUILDKIT=1 docker build -f deploy/web.Dockerfile    -t $(IMAGE_PREFIX)/web:$(IMAGE_TAG) \
	  --build-arg API_URL=$(WEB_API_URL) .

compose-up: ## production compose stack up (needs deploy/.env)
	@[[ -f deploy/.env ]] || { echo "copy deploy/.env.example to deploy/.env and fill the secrets"; exit 1; }
	$(COMPOSE) up -d --build

compose-down: ## production compose stack down (volumes kept)
	$(COMPOSE) down

# --------------------------------------------------------------------------------------------
# Operations (against $DATABASE_URL / PG* env, as the schema owner)
# --------------------------------------------------------------------------------------------
migrate: ## apply pending db/migrations (deploy/migrate.sh)
	@deploy/migrate.sh

partitions: ## ensure message_logs partitions (+ retention if MESSAGE_LOG_RETENTION is set)
	@deploy/init/maintenance.sh
