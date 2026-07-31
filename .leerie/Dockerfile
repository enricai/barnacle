# leerie-generated: do not edit (regenerated from .leerie/config.toml)
ARG BASE_IMAGE
FROM $BASE_IMAGE
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*
