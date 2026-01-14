#!/bin/bash
set -e

echo "🚀 Starting SONIQ Migration Worker..."

# Start Redis in background (nixpkgs provides redis-server in PATH)
echo "📦 Starting Redis..."
redis-server --daemonize yes --port ${REDIS_PORT:-6379} --bind 127.0.0.1 --save "" --appendonly no

# Wait for Redis to be ready
echo "⏳ Waiting for Redis..."
timeout 30 bash -c 'until redis-cli -h 127.0.0.1 -p ${REDIS_PORT:-6379} ping 2>/dev/null | grep -q PONG; do 
  echo "  Redis not ready yet..."
  sleep 1
done' || {
  echo "❌ Redis failed to start after 30 seconds"
  exit 1
}

echo "✅ Redis is ready!"

# Check Node.js
echo "🔍 Node.js version: $(node --version)"
echo "📂 Working directory: $(pwd)"
echo "📄 Files: $(ls -la dist/ | head -5)"

# Start the Node.js application
echo "🚀 Starting Node.js application..."
exec node dist/index.js
