# =========================
# 1. Build stage
# =========================
FROM rust:1.89-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN cargo build --release --bin gil-tube-downloader


# =========================
# 2. Runtime stage
# =========================
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/gil-tube-downloader /app/gil-tube-downloader

EXPOSE 8000

CMD ["/app/gil-tube-downloader", "--serve"]
