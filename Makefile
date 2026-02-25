.PHONY: up down build restart logs shell dev clean run-local test

## Start the dashboard (build if needed)
up:
	docker compose up --build -d
	@echo ""
	@echo "  Dashboard running at http://localhost:8080"
	@echo "  Drop sprint CSVs into ./data/ — no restart needed."
	@echo ""

## Stop the dashboard
down:
	docker compose down

## Rebuild the image without cache
build:
	docker compose build --no-cache

## Restart the container
restart:
	docker compose restart

## Follow live logs
logs:
	docker compose logs -f

## Open a shell inside the running container
shell:
	docker compose exec time-tracker /bin/bash

## Start in foreground (useful for debugging)
dev:
	docker compose up --build

## Remove containers, images, and volumes created by this project
clean:
	docker compose down --rmi local --volumes --remove-orphans

## Run the server locally without Docker (requires .venv)
run-local:
	.venv/bin/python server.py

## Run JS unit tests (requires Node.js)
test:
	node tests/test_capacity.js
