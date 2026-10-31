# Zenith — production image, built on Next's `output: "standalone"` tracing.
#
# Installing dependencies and pulling base images require network access.
# Fonts are self-hosted in public/fonts; Next compilation does not fetch them.
# Both production and Docker builds are mandatory CI gates.
#
# Layout follows the official Next standalone example:
# https://github.com/vercel/next.js/tree/canary/examples/with-docker

# ---------------------------------- deps ------------------------------------
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
# Next's SWC binaries want glibc symbols that musl does not provide alone.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
# The lint toolchain's minimatch 3.x API over patched minimatch 11 (package.json overrides); npm ci links it.
COPY vendor/minimatch3-compat ./vendor/minimatch3-compat
# Frozen (`ci`, not `install`) and script-free: no dependency's install/postinstall
# runs while the image is built, so a compromised transitive package cannot bake
# itself into the image. Nothing in this tree needs a lifecycle script — the only
# three packages that declare one are `esbuild` (its platform binary comes from
# the `@esbuild/*` optional package, resolved at require time), `fsevents`
# (macOS-only, optional, never installed here) and `unrs-resolver` (its native
# binding likewise resolves from the installed platform package). Evidence:
# `npm ci --ignore-scripts` in a scratch copy of this lockfile installed 698
# packages, after which `require("esbuild")` transformed TypeScript and
# `unrs-resolver`'s native `ResolverFactory` loaded. That was on win32-x64, not
# this image's linux/musl — see docs/hosted/PROVIDERS.md for what is unverified.
RUN npm ci --ignore-scripts

# --------------------------------- builder ----------------------------------
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, not read at
# run time — passing them only via env_file leaves the browser with an
# unconfigured Supabase client and the app silently in local demo mode. So they
# are build args. Empty is a valid choice: it builds demo mode on purpose.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=""
ARG NEXT_PUBLIC_SITE_URL=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=$NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

# next build type-checks the complete source graph, which exceeds Node's default heap.
# Build stage only: the runner stage does not inherit this.
ENV NODE_OPTIONS=--max-old-space-size=5120
# Compile with the public brand/font assets included in the build context.
RUN mkdir -p public && npm run build

# ---------------------------------- runner ----------------------------------
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3400 \
    HOSTNAME=0.0.0.0 \
    ZENITH_DATA=/data

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs zenith

# standalone/ carries server.js and the traced node_modules; static/ and
# public/ are NOT traced into it and must be copied alongside by hand.
COPY --from=builder --chown=zenith:nodejs /app/public ./public

# .next is created and chowned before anything lands in it, per the official
# example: the standalone server writes .next/cache at run time, and a
# root-owned .next makes that fail under USER zenith.
RUN mkdir .next && chown zenith:nodejs .next

COPY --from=builder --chown=zenith:nodejs /app/.next/standalone ./
COPY --from=builder --chown=zenith:nodejs /app/.next/static ./.next/static

# Hosted build recipe (src/lib/hosted/build). The worker is spawned by path,
# so output tracing never sees it; it and its shared config must sit at the
# same relative location as in the source tree. The pinned Vite toolchain is
# NOT traced into standalone/ either: with the default runner (`none`) that
# is fine, and the isolated runners (`docker`, `e2b`) carry their own copy
# (docker/recipe/Dockerfile). Only the opt-in same-host runner needs it here,
# so it is installed only when ZENITH_RECIPE_LOCAL=1 is passed at build time.
COPY --from=builder --chown=zenith:nodejs /app/src/lib/hosted/build/recipe-worker.mjs ./src/lib/hosted/build/recipe-worker.mjs
COPY --from=builder --chown=zenith:nodejs /app/src/lib/hosted/build/recipe-config.mjs ./src/lib/hosted/build/recipe-config.mjs
# The two reference source packages a publish may name by fixture id
# (src/lib/hosted/release/intent.ts FIXTURES). Plain source files, no build.
COPY --from=builder --chown=zenith:nodejs /app/fixtures ./fixtures
#
# The toolchain is installed from the same committed lockfile the `docker`
# runner's recipe image uses (docker/recipe/package-lock.json), so the two
# images carry a provably identical tree: frozen (`npm ci`, resolved exactly as
# the lockfile records) and script-free (`--ignore-scripts`). It is installed in
# a scratch directory and merged into /app/node_modules rather than installed
# there, because `npm ci` empties the node_modules of the directory it runs in
# and /app/node_modules is Next's traced standalone tree.
COPY docker/recipe/package.json docker/recipe/package-lock.json /opt/zenith-recipe/
ARG ZENITH_RECIPE_LOCAL=0
RUN if [ "$ZENITH_RECIPE_LOCAL" = "1" ]; then \
      cd /opt/zenith-recipe \
      && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
      && mkdir -p /app/node_modules \
      && cp -R /opt/zenith-recipe/node_modules/. /app/node_modules/ \
      && rm -rf /opt/zenith-recipe/node_modules \
      && npm cache clean --force \
      && chown -R zenith:nodejs /app/node_modules; \
    fi

# Docker seeds a fresh named volume from the image directory at the mount
# point, ownership included. Creating /data as zenith here is what makes the
# volume writable by a non-root process; without it the first save fails EACCES.
RUN mkdir -p /data && chown zenith:nodejs /data
VOLUME /data

USER zenith
EXPOSE 3400

# node is guaranteed present; curl and wget are not worth an apk layer.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3400/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
