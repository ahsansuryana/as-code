FROM node:20-slim

# Install common development tools inside container for agent exec commands
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependencies manifest
COPY package*.json ./
RUN npm ci

# Copy configuration and TypeScript source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Create data directory and default workspace mount point
RUN mkdir -p /app/data /workspace

EXPOSE 3000

# Default environment inside container
ENV BIND_ADDRESS=0.0.0.0
ENV PORT=3000
ENV PROJECT_ROOT=/workspace

CMD ["node", "dist/index.js"]
