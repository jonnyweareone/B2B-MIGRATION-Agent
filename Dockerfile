# Use Node.js 20 Alpine (lightweight)
FROM node:20-alpine

# Install Redis
RUN apk add --no-cache redis

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port (Railway sets PORT env var)
EXPOSE ${PORT:-3000}

# Make start script executable
RUN chmod +x start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-3000}/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start services
CMD ["./start.sh"]
