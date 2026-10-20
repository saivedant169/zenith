# Verifier supplies both native image references pinned by digest.
ARG GO_BUILDER_IMAGE
ARG DISTROLESS_IMAGE
FROM ${GO_BUILDER_IMAGE} AS build
ENV GOMAXPROCS=2 GOMEMLIMIT=512MiB
WORKDIR /src/go
COPY go/ ./
COPY tests/e2e/default/witness.go /src/witness.go
RUN GOTOOLCHAIN=local CGO_ENABLED=0 go build -p 2 -trimpath -o /out/zenithd ./cmd/zenithd \
 && GOTOOLCHAIN=local CGO_ENABLED=0 go build -p 2 -trimpath -o /out/witness /src/witness.go \
 && mkdir -p /out/state/zenithd /out/witness-state/witness && chmod 0700 /out/state/zenithd /out/witness-state/witness
FROM ${DISTROLESS_IMAGE}
COPY --from=build /out/zenithd /usr/local/bin/zenithd
COPY --from=build /out/witness /usr/local/bin/witness
# Copy each 0700 directory as an entry of its parent, so it keeps its own mode.
# A COPY destination directory gets the builder's default mode, and older
# BuildKit leaves it 0755 even with --chmod; /var/lib and / are unchanged.
COPY --from=build --chown=65532:65532 /out/state/ /var/lib/
COPY --from=build --chown=65532:65532 /out/witness-state/ /
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/witness"]
CMD ["serve"]
