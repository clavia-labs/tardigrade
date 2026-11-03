FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:1.0.3 AS helpers
FROM --platform=linux/amd64 debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fuse3 s3fs python3 && rm -rf /var/lib/apt/lists/*
COPY --from=helpers /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY entrypoint.sh /usr/local/bin/workspace-entrypoint
COPY flush.py /usr/local/bin/workspace-flush
RUN chmod +x /usr/local/bin/workspace-entrypoint
ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]
