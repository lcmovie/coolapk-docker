# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=640
RUN npm run build

FROM rust:1-bookworm AS backend
WORKDIR /build
# Limit compilation concurrency for the NAS. No GTK, WebKit or desktop runtime
# is needed: this target compiles the HTTP service and shared Coolapk client.
ENV CARGO_BUILD_JOBS=1 \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
COPY . .
# This dependency keeps Node and Rust builds sequential even with BuildKit,
# preventing their combined memory use on a small NAS.
COPY --from=frontend /build/dist /build/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/web-server/target,sharing=locked \
    cargo test --manifest-path web-server/Cargo.toml --locked --release --jobs 1 \
    && cargo build --manifest-path web-server/Cargo.toml --locked --release --jobs 1 \
    && install -D web-server/target/release/coolapk-web-server /out/coolapk-web-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 coolapk \
    && useradd --uid 1000 --gid coolapk --no-create-home --home-dir /app/data coolapk \
    && install -d -m 0700 -o coolapk -g coolapk /app/data
WORKDIR /app
COPY --from=backend /out/coolapk-web-server /app/coolapk-web-server
COPY --from=frontend /build/dist /app/dist
ENV COOLAPK_PORT=8080 \
    COOLAPK_DATA_DIR=/app/data \
    COOLAPK_STATIC_DIR=/app/dist \
    HOME=/app/data \
    RUST_LOG=info
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/app/coolapk-web-server"]
