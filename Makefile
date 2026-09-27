SHELL := /bin/sh

.PHONY: install clean build test test-unit test-integration test-e2e test-mutation start dev dev-remote help

FRONTEND_PORT ?= 3000
BACKEND_PORT ?= 3001

# Host name that a browser inside a Lima VM uses to reach this machine. Lima
# forwards host.lima.internal to the host's loopback, so both services keep
# their loopback binding; only the frontend's inlined WebSocket URL and the
# backend's origin/host allow-list need to name that host.
REMOTE_HOST ?= host.lima.internal

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.* ## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

clean: ## Remove build artifacts
	rm -rf .next out test-results

build: ## Clean and build the project
	$(MAKE) clean
	npm run build

test: ## Release gate: unit, integration, types, build, and browser tests
	node scripts/run-checks.mjs

test-unit: ## Run unit tests
	npm run test:unit

test-integration: ## Run integration tests
	npm run test:integration

test-e2e: ## Run end-to-end tests
	npm run test:e2e

test-mutation: ## Run mutation testing (Stryker) over the audited modules
	npm run test:mutation

start: build ## Build and start production server (port 3000)
	node scripts/start.mjs

dev: ## Clean and start frontend + backend dev servers
	$(MAKE) clean
	npm run dev:auto

dev-remote: ## Start dev servers for a browser in a Lima VM (override REMOTE_HOST)
	$(MAKE) clean
	NEXT_PUBLIC_WS_URL=ws://$(REMOTE_HOST):$(BACKEND_PORT) \
	BACKEND_ALLOWED_ORIGINS=http://$(REMOTE_HOST):$(FRONTEND_PORT),http://localhost:$(FRONTEND_PORT),http://127.0.0.1:$(FRONTEND_PORT) \
	FRONTEND_PORT=$(FRONTEND_PORT) BACKEND_PORT=$(BACKEND_PORT) OPEN_BROWSER=0 node scripts/run-dev.mjs
