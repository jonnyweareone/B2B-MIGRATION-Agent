#!/bin/bash
set -e

echo "🚀 Starting SONIQ Migration Worker..."
echo "📍 PORT: ${PORT:-3000}"
echo "📍 REDIS_HOST: ${REDIS_HOST:-127.0.0.1}"
echo "📍 REDIS_PORT: ${REDIS_PORT:-6379}"

# Start Redis in background (nixpkgs provides redis-server in PATH)
echo "📦 Starting Redis on 127.0.0.1:${REDIS_PORT:-6379}..."
redis-server --daemonize yes --port ${REDIS_PORT:-6379} --bind 127.0.0.1 --save "" --appendonly no --loglevel notice

# Wait for Redis to be ready
echo "⏳ Waiting for Redis..."
for i in {1..30}; do
  if redis-cli -h 127.0.0.1 -p ${REDIS_PORT:-6379} ping 2>/dev/null | grep -q PONG; then
    echo "✅ Redis is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ Redis failed to start after 30 seconds"
    redis-cli -h 127.0.0.1 -p ${REDIS_PORT:-6379} ping 2>&1
    exit 1
  fi
  echo "  Attempt $i/30..."
  sleep 1
done

# Check Node.js and files
echo "🔍 Node.js version: $(node --version)"
echo "📂 Working directory: $(pwd)"
echo "📄 Checking dist/index.js..."
if [ -f "dist/index.js" ]; then
  echo "✅ dist/index.js exists"
else
  echo "❌ dist/index.js not found!"
  ls -la dist/ || echo "dist/ directory not found!"
  exit 1
fi

# Start the Node.js application
echo "🚀 Starting Node.js application on port ${PORT:-3000}..."
exec node dist/index.js
