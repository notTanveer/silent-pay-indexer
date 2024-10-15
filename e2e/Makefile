# Variables
DOCKER_COMPOSE_FILE = helpers/docker/docker-compose.yml
NESTJS_SERVICE_PORT = 3000
NESTJS_TEST_CMD = npm run test:e2e 
MAX_RETRIES = 10 # Number of retries to check if the inddexer service is up
RETRY_INTERVAL = 5 # Seconds between retries
PM2_CMD = pm2
NPM_CMD = npm
APP_NAME = silent-indexer

# Targets
.PHONY: all up down test wait-for-service clean start-service

# Default target
all: test 

# Start Docker Compose services
up: down
	@echo "Starting Docker Compose services..."
	docker compose -f $(DOCKER_COMPOSE_FILE) up -d

# Stop and remove Docker Compose services
down:
	@echo "Stopping and removing Docker Compose services..."
	docker compose -f $(DOCKER_COMPOSE_FILE) down -v
	$(PM2_CMD) delete $(APP_NAME) || echo "Warning: PM2 delete command failed, but continuing..."
	@echo "Clean up completed."

# Start the Indexer service
start-service:
	@echo "Starting the Indexer service with PM2..."
	$(PM2_CMD) start $(NPM_CMD) --name $(APP_NAME) -- run start:e2e

# Wait for the Indexer service to be available before running tests
wait-for-service:
	@echo "Waiting for Indexer service to be ready on port $(NESTJS_SERVICE_PORT)..."
	@count=0; \
	while ! nc -z localhost $(NESTJS_SERVICE_PORT) && [ $$count -lt $(MAX_RETRIES) ]; do \
		count=$$((count + 1)); \
		echo "Waiting for service... ($$count/$(MAX_RETRIES))"; \
		sleep $(RETRY_INTERVAL); \
	done; \
	if ! nc -z localhost $(NESTJS_SERVICE_PORT); then \
		echo "Error: Service not available after $(MAX_RETRIES) retries, exiting."; \
		exit 1; \
	fi

# Run the end-to-end tests
test: up start-service wait-for-service
	@echo "Running end-to-end tests..."
	$(NESTJS_TEST_CMD)

# Clean up
clean: down
	@echo "Clean up completed."

all: | down