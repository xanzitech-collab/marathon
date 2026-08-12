# Single-stage build on purpose: youtube-dl-exec's downloaded yt-dlp binary
# and canvas's compiled native binding are both found via runtime __dirname
# lookups inside node_modules, not static imports — Next's standalone output
# tracer (and its aggressive node_modules pruning) can't reliably see those
# and has already caused missing-binary crashes once before (see
# next.config.ts). Shipping the full node_modules avoids that risk entirely;
# the extra image size is a fine trade-off for correctness here.
FROM node:20-bookworm AS base

# ffmpeg: used directly (spawn) for soundtrack rendering and image prep.
# fonts-dejavu-core: caption/meme text overlays need a real font file on disk
# (see meme-image.ts/ffmpeg-processor.ts) — nothing is installed by default.
# The rest: canvas's native build dependencies (per canvas's own install docs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    build-essential \
    python3 \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Chromium + its OS-level deps for playwright, used to screenshot X/Twitter
# posts with an authenticated (cookie) session — no anonymous scraping API
# exists for that, unlike TikTok/YouTube's yt-dlp path.
RUN npx playwright install --with-deps chromium

COPY . .

# youtube-dl-exec's postinstall (which downloads the yt-dlp binary) already
# ran during npm ci above, while network access is available.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
