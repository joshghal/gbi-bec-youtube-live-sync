FROM node:20-slim

# yt-dlp + ffmpeg + Deno (JS challenge solver needed when using cookies for GCP-IP bot bypass)
RUN apt-get update && apt-get install -y \
  python3 \
  python3-pip \
  ffmpeg \
  ca-certificates \
  curl \
  unzip \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp yt-dlp-ejs \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --yes \
  && ln -sf /usr/local/bin/deno /usr/bin/deno

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# tsx is used by sunday-runner.ts to spawn live-summary.ts as a child.
# In production we'd compile and use node dist/... but tsx avoids re-spawn complexity.
CMD ["node", "dist/sunday-runner.js"]
