# Folio's rendition worker. Built from the repo root:
#   docker build -f apps/folio/worker/Dockerfile -t folio-worker .
FROM python:3.12-slim-bookworm
LABEL org.opencontainers.image.source="https://github.com/harry-burton-dev/im-platform"

# Docling's PDF pipeline draws pages with these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 folio
WORKDIR /app

COPY apps/folio/worker/pyproject.toml ./
COPY apps/folio/worker/folio_worker ./folio_worker
# Torch's CPU-only build: the CUDA one is gigabytes the worker never uses.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu .

USER folio
# Docling's models go in the image, so the worker never fetches anything from outside at run time.
ENV HF_HOME=/home/folio/.cache/huggingface \
  DOCLING_ARTIFACTS_PATH=/home/folio/.cache/docling/models \
  HF_HUB_OFFLINE=1 \
  PYTHONUNBUFFERED=1
RUN HF_HUB_OFFLINE=0 docling-tools models download -o "$DOCLING_ARTIFACTS_PATH"

CMD ["python", "-m", "folio_worker"]
