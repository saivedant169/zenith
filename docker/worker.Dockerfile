# syntax=docker/dockerfile:1
#
# Zenith execution worker image (ADR-0009, docs/platform/EXECUTION-WORKER.md).
#
#   docker build -f docker/worker.Dockerfile -t zenith-execution-worker .
#
# Build context is the repository root.
#
# STATUS: local linux/arm64 image built successfully on 2026-10-02. CLI probes
# with networking disabled and a read-only root filesystem verified Node
# v22.23.3, non-root uid 10001, OpenTofu 1.12.5/linux_arm64, and the packaged
# policy WASM SHA-256 matching its manifest. No Zenith worker/server was started.
# The AMD64 image build, worker startup/Temporal polling, cloud transports, and
# production operation remain unverified for this image.
#
# Contents: Node 22.23.3 (Debian slim) + OpenTofu 1.12.5 + the bundled worker +
# a prebuilt workflow bundle. The worker runs as a non-root user; its health
# listener is loopback-only and needs no published inbound port.
#
# Everything downloaded is pinned and verified:
#   - the base image by tag AND digest (the multi-arch index digest of
#     node:22.23.3-slim, read from the registry on 2026-10-02);
#   - OpenTofu by version AND SHA-256, from the official release's
#     tofu_1.12.5_SHA256SUMS. The build FAILS when a checksum is empty or does
#     not match. To bump OpenTofu, change TOFU_VERSION and BOTH checksums from
#     https://github.com/opentofu/opentofu/releases/download/v<version>/tofu_<version>_SHA256SUMS
#     (the SHA256SUMS file is also cosign-signed; that signature is not
#     verified here).
#
ARG NODE_IMAGE=node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG TOFU_VERSION=1.12.5
ARG TOFU_SHA256_AMD64=dade9650e6b74fc7a8b986bd8717497d32f9e09cf82e479afef4977fa3085536
ARG TOFU_SHA256_ARM64=528f4eea63452bbddb30fa4f1780b57fac8d7676f9dda0f772e847bb62c1260a

# ---------------------------------- tofu ------------------------------------
# Fetch and verify OpenTofu in a throwaway stage so curl/unzip never reach the
# runtime image.
FROM ${NODE_IMAGE} AS tofu
ARG TARGETARCH
ARG TOFU_VERSION
ARG TOFU_SHA256_AMD64
ARG TOFU_SHA256_ARM64
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) expected="${TOFU_SHA256_AMD64}" ;; \
      arm64) expected="${TOFU_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    [ -n "${TOFU_VERSION}" ] || { echo "TOFU_VERSION is empty" >&2; exit 1; }; \
    [ -n "$expected" ] || { echo "OpenTofu checksum for $arch is empty; refusing to install an unverified binary" >&2; exit 1; }; \
    curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/tofu.zip \
      "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip"; \
    echo "${expected}  /tmp/tofu.zip" | sha256sum -c -; \
    unzip -q /tmp/tofu.zip tofu -d /usr/local/bin; \
    chmod 0755 /usr/local/bin/tofu; \
    /usr/local/bin/tofu version | head -n 1 | grep -F "OpenTofu v${TOFU_VERSION}"; \
    mkdir -p /usr/local/share/zenith; \
    binary_sha="$(sha256sum /usr/local/bin/tofu | cut -d ' ' -f 1)"; \
    printf '{"version":"%s","platform":"linux_%s","sha256":"%s","archiveSha256":"%s"}\n' "${TOFU_VERSION}" "$arch" "$binary_sha" "$expected" > /usr/local/share/zenith/tofu-identity.json

# --------------------------------- build ------------------------------------
# Full install (dev dependencies: tsx, esbuild), then compile the worker and
# bundle the workflow definitions. Lifecycle scripts stay off, as in the root
# Dockerfile.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The lint toolchain's minimatch 3.x API over patched minimatch 11 (package.json overrides); npm ci links it.
COPY vendor/minimatch3-compat ./vendor/minimatch3-compat
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src/lib ./src/lib
COPY workers/execution ./workers/execution
# SSM command documents are JSON imports compiled into the worker bundle.
COPY deploy/aws/ssm-documents ./deploy/aws/ssm-documents
COPY deploy/slo/slo-definitions.json ./deploy/slo/slo-definitions.json
# `@/` imports are resolved from tsconfig `paths` and bundled; every package
# import stays external and is satisfied by node_modules in the runtime stage.
RUN npx esbuild workers/execution/entrypoint.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --packages=external --tsconfig=tsconfig.json \
      --outfile=dist/execution/worker.cjs \
 && npx esbuild workers/execution/packaged-client.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --packages=external --tsconfig=tsconfig.json \
      --outfile=dist/acceptance/packaged-client.cjs \
 && npx tsx workers/execution/build-bundle.ts dist/execution/workflow-bundle.js

# --------------------------------- runtime ----------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    ZENITH_TOFU_IDENTITY_FILE=/usr/local/share/zenith/tofu-identity.json \
    ZENITH_DATA=/var/lib/zenith \
    ZENITH_WORKER_PLAN_DIR=/var/lib/zenith/platform-plans \
    ZENITH_WORKER_WORKFLOW_BUNDLE=/app/dist/execution/workflow-bundle.js
# tini: PID 1 that forwards SIGTERM to the worker (which drains) and reaps the
# orphaned provider processes an interrupted `tofu` can leave behind.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 zenith \
 && useradd --system --uid 10001 --gid zenith --home-dir /home/zenith --create-home --shell /usr/sbin/nologin zenith \
 && mkdir -p /var/lib/zenith/platform-plans \
 && chown -R zenith:zenith /var/lib/zenith \
 && chmod 0700 /var/lib/zenith /var/lib/zenith/platform-plans
WORKDIR /app
COPY package.json package-lock.json ./
# The lint toolchain's minimatch 3.x API over patched minimatch 11 (package.json overrides); npm ci links it.
COPY vendor/minimatch3-compat ./vendor/minimatch3-compat
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
COPY --from=tofu /usr/local/share/zenith/tofu-identity.json /usr/local/share/zenith/tofu-identity.json
COPY --from=build --chown=zenith:zenith /app/dist/execution ./dist/execution
# loadPolicyEngine resolves <cwd>/policy/dist/policy.wasm and verifies the
# sibling manifest. Ship the committed bundle; no OPA compiler is needed here.
COPY --chown=zenith:zenith policy/dist ./policy/dist

# /var/lib/zenith is the only place the worker (and OpenTofu working
# directories) should write besides /tmp; a read-only root filesystem works with
# those two as writable volumes. No secrets are baked in: the Temporal API key
# (ZENITH_TEMPORAL_API_KEY) and everything else arrive as environment at run time.
USER zenith
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ZENITH_WORKER_HEALTH_PORT||9464)+'/readyz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"]

# Explicit opt-in derivative only. The default production target below excludes
# the fixture client and all store-seeding code.
FROM runtime AS acceptance
COPY --from=build --chown=zenith:zenith /app/dist/acceptance ./dist/acceptance

FROM runtime AS production
