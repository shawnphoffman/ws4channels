FROM node:22-slim

# Shared libs for chrome-headless-shell + ffmpeg + VA-API drivers
RUN apt-get update && apt-get install -y --no-install-recommends \
	ffmpeg \
	mesa-va-drivers \
	ca-certificates \
	fonts-liberation \
	libasound2 \
	libdrm2 \
	libgbm1 \
	libnspr4 \
	libnss3 \
	libx11-6 \
	libxcb1 \
	libxcomposite1 \
	libxdamage1 \
	libxext6 \
	libxfixes3 \
	libxrandr2 \
	libxkbcommon0 \
	&& (apt-get install -y --no-install-recommends intel-media-va-driver || true) \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Download chrome-headless-shell matching puppeteer-core version
RUN npm install -g @puppeteer/browsers \
	&& browsers install chrome-headless-shell@stable --path /app/.chrome \
	&& ln -s $(find /app/.chrome -name chrome-headless-shell -type f | head -1) /usr/local/bin/chrome-headless-shell \
	&& npm uninstall -g @puppeteer/browsers \
	&& npm cache clean --force

ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-headless-shell

# Copy application code, music, and logo files
COPY . .

# Use STREAM_PORT environment variable for dynamic port
EXPOSE $STREAM_PORT

HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=5 \
	CMD node -e "require('http').get('http://localhost:' + (process.env.STREAM_PORT || 9798) + '/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
