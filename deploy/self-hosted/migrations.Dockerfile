# Operator builds from a clean committed repository context and records digest.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN apk add --no-cache libc6-compat && addgroup -g 1001 zenith && adduser -D -u 1001 -G zenith zenith
WORKDIR /app
COPY package.json package-lock.json ./
# The lint toolchain's minimatch 3.x API over patched minimatch 11 (package.json overrides); npm ci links it.
COPY vendor/minimatch3-compat ./vendor/minimatch3-compat
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/platform ./scripts/platform
COPY src ./src
ENV NODE_ENV=production
USER 1001:1001
ENTRYPOINT ["node", "--import", "tsx", "scripts/platform/migrate.ts"]
