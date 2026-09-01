FROM node:20-slim

# Install common development tools inside container for agent exec commands
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    build-essential \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install the docker compose v2 CLI plugin (not packaged in Debian's apt
# repo). Fetches the binary matching the build machine's architecture and
# installs it into the standard system-wide CLI plugin directory.
RUN COMPOSE_VERSION=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | \
      grep -m1 '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/') \
    && ARCH=$(uname -m) \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

WORKDIR /app

# Copy dependencies manifest
COPY package*.json ./
RUN npm ci

# Copy configuration and TypeScript source
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
# Git invokes GIT_ASKPASS directly, so preserve its executable bit.
RUN chmod +x scripts/git-askpass.mjs

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
