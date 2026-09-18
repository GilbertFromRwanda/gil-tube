FROM python:3.12-slim

# yt-dlp needs a JS runtime to solve YouTube's signature/PoToken challenges
# on some clients; without one it falls back to slower, less reliable
# extraction paths and can intermittently hang past our timeout. deno is the
# runtime yt-dlp auto-detects and enables by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get purge -y --auto-remove curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 9000

# Flask's own dev server (used by `python main.py` for local/non-Docker dev)
# handles one request at a time by default, which serializes every request -
# including unrelated ones like /health - behind whichever yt-dlp call is
# currently running. gunicorn with multiple worker processes and threads
# lets search/extract/health run concurrently instead of queueing.
CMD ["gunicorn", "--workers", "2", "--threads", "4", "--timeout", "120", "--bind", "0.0.0.0:9000", "main:app"]
