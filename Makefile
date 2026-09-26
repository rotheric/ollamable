SHELL := /bin/sh

.PHONY: install clean build test test-unit test-integration test-e2e test-mutation start dev dev-remote help

# Ports for the local services behind a configured remote-development proxy.
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
	node scripts/start.mjs

dev: ## Clean and start frontend + backend dev servers
	$(MAKE) clean
	npm run dev:auto

dev-remote: ## Start behind an authenticated proxy (set NEXT_PUBLIC_WS_URL and BACKEND_ALLOWED_ORIGINS)
	@test -n "$(NEXT_PUBLIC_WS_URL)" -a -n "$(BACKEND_ALLOWED_ORIGINS)" -a -n "$(BACKEND_AUTH_TOKEN)" || { echo "Set NEXT_PUBLIC_WS_URL, BACKEND_ALLOWED_ORIGINS and BACKEND_AUTH_TOKEN for the authenticated proxy." >&2; exit 1; }
	FRONTEND_PORT=$(FRONTEND_PORT) BACKEND_PORT=$(BACKEND_PORT) node scripts/run-dev.mjs
