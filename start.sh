#!/bin/bash

# Start Redis in background
echo "Starting Redis..."
redis-server --daemonize yes --port ${REDIS_PORT:-6379}

# Wait for Redis to be ready
echo "Waiting for Redis..."
timeout 10 bash -c 'until redis-cli ping 2>/dev/null; do sleep 0.5; done' || {
  echo "Redis failed to start"
  exit 1
}

echo "Redis is ready!"

# Start the Node.js application
echo "Starting Node.js application..."
exec node dist/index.js
