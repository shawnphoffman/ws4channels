FROM node:22-slim

# Install FFmpeg, Chromium, and VA-API driver for Intel Arc (Meteor Lake+)
RUN apt-get update && apt-get install -y --no-install-recommends \
	ffmpeg \
	chromium \
	mesa-va-drivers \
	intel-media-va-driver \
	&& rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of Puppeteer's bundled download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Copy application code, music, and logo files
COPY . .

# Use STREAM_PORT environment variable for dynamic port
EXPOSE $STREAM_PORT
CMD ["node", "index.js"]
