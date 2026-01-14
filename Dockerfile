# Use Node.js 20 Alpine (lightweight)
FROM node:20-alpine

# Install Redis
RUN apk add --no-cache redis bash

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove devDependencies after build (saves space)
RUN npm prune --production

# Make start script executable
RUN chmod +x start.sh

# Expose port (Railway sets PORT env var)
EXPOSE 3000

# Start services
CMD ["bash", "start.sh"]
