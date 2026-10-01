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

# Expose port
EXPOSE 3000

# Set environment variable for production
ENV NODE_ENV=production
ENV PORT=3000

# Run server
CMD ["npm", "start"]
