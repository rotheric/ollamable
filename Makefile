SHELL := /bin/zsh

.PHONY: install clean build test test-unit test-integration test-e2e test-mutation start dev dev-remote help

# Host that a non-local browser (Lima VM, phone, other LAN machine) uses to
# reach this machine. NEXT_PUBLIC_WS_URL is inlined at dev-server startup, so
# it must name a host the *browser* can resolve, not this machine's loopback.
REMOTE_HOST ?= host.lima.internal
FRONTEND_PORT ?= 3000
BACKEND_PORT ?= 3001

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.* ## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

clean: ## Remove build artifacts
	rm -rf .next out test-results

build: ## Clean and build the project
	$(MAKE) clean
	npm run build

test: ## Run all tests (unit + e2e)
	npm run test:unit
	npm run test:e2e

test-unit: ## Run unit tests
	npm run test:unit

test-integration: ## Run integration tests
	npm run test:integration

test-e2e: ## Run end-to-end tests
	npm run test:e2e

test-mutation: ## Run mutation testing (Stryker) over the audited modules
	npm run test:mutation

start: build ## Build and start production server (port 3000)
	node --import tsx server/index.ts

dev: ## Clean and start frontend + backend dev servers
	$(MAKE) clean
	npm run dev:auto

dev-remote: ## Start dev servers reachable from the Lima VM / LAN (override REMOTE_HOST)
	$(MAKE) clean
	npx concurrently -n next,server -c cyan,magenta \
	  "NEXT_PUBLIC_WS_URL=ws://$(REMOTE_HOST):$(BACKEND_PORT) npm run dev -- --hostname 0.0.0.0 --port $(FRONTEND_PORT)" \
	  "PORT=$(BACKEND_PORT) npm run dev:server"
