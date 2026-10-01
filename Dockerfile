# Production Dockerfile for SENTINEL-X RTSP Streamer
FROM node:20-slim

# Install FFmpeg and required dependencies via apt
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency definition files first for optimal layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application source code
COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
