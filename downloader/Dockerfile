FROM rust:1.89-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN cargo build --release --bin gil-tube-downloader

EXPOSE 8000

CMD ["./target/release/gil-tube-downloader", "--serve"]
