# Folio's rendition worker. Built from the repo root:
#   docker build -f worker/Dockerfile -t folio-worker .
FROM python:3.12-slim-bookworm
LABEL org.opencontainers.image.source="https://github.com/harry-burton-dev/augur-folio"
LABEL org.opencontainers.image.licenses="LicenseRef-AUGUR-Proprietary"

# Docling's PDF pipeline draws pages with these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 folio
WORKDIR /app

# Every package from worker/requirements.lock, checked against its hashes, with Torch's CPU-only build from
# its own index, which the lock names (the CUDA one is gigabytes the worker never uses). Then the worker
# itself, with nothing more resolved (worker/lock.sh).
COPY worker/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY worker/pyproject.toml ./
COPY worker/folio_worker ./folio_worker
RUN pip install --no-cache-dir --no-deps .

USER folio
# Docling's models go in the image, so the worker never fetches anything from outside at run time.
ENV HF_HOME=/home/folio/.cache/huggingface \
  DOCLING_ARTIFACTS_PATH=/home/folio/.cache/docling/models \
  HF_HUB_OFFLINE=1 \
  PYTHONUNBUFFERED=1
RUN HF_HUB_OFFLINE=0 docling-tools models download -o "$DOCLING_ARTIFACTS_PATH"

# Healthy while the worker keeps reaching its database (folio_worker/health.py). Loading Docling's models
# takes a while, so the first beats get two minutes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["python", "-m", "folio_worker.health"]

CMD ["python", "-m", "folio_worker"]
