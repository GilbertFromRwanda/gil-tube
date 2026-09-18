FROM python:3.12-slim

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
