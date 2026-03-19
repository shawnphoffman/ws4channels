FROM node:18

# Install FFmpeg and Chromium (system browser for Puppeteer)
RUN apt-get update && apt-get install -y --no-install-recommends \
ffmpeg \
chromium \
&& rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of Puppeteer's bundled download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy application code, music, and logo files
COPY . .

# Use STREAM_PORT environment variable for dynamic port
EXPOSE $STREAM_PORT
CMD ["node", "index.js"]
