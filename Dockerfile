# Pramaan — runtime image (Node 22, distroless-ish, test mode only)
FROM node:22-slim

WORKDIR /app

# Install first (layer cache), then copy the build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build inside the image so the deployed artifact is always reproducible
# from source (a judge can diff Dockerfile against the repo and trust it).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY catalog.json ./
RUN npm ci && npx tsc -p tsconfig.json && npm prune --omit=dev

ENV PRAMAAN_PORT=8080
ENV NODE_ENV=production
# Ledger + sidecars live on the mounted volume.
ENV PRAMAAN_DB=/data/pramaan.db
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "dist/src/server.js"]
