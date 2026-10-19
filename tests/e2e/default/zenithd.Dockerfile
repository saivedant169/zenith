# Verifier supplies both native ARM64 image references pinned by digest.
ARG GO_BUILDER_IMAGE
ARG DISTROLESS_IMAGE
FROM ${GO_BUILDER_IMAGE} AS build
ENV GOMAXPROCS=2 GOMEMLIMIT=512MiB
WORKDIR /src/go
COPY go/ ./
COPY tests/e2e/default/witness.go /src/witness.go
RUN GOTOOLCHAIN=local CGO_ENABLED=0 go build -p 2 -trimpath -o /out/zenithd ./cmd/zenithd \
 && GOTOOLCHAIN=local CGO_ENABLED=0 go build -p 2 -trimpath -o /out/witness /src/witness.go \
 && mkdir -p /out/state /out/witness-state && chmod 0700 /out/state /out/witness-state
FROM ${DISTROLESS_IMAGE}
COPY --from=build /out/zenithd /usr/local/bin/zenithd
COPY --from=build /out/witness /usr/local/bin/witness
COPY --from=build --chown=65532:65532 --chmod=0700 /out/state /var/lib/zenithd
COPY --from=build --chown=65532:65532 --chmod=0700 /out/witness-state /witness
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/witness"]
CMD ["serve"]
