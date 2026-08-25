ARG CELLD_IMAGE=ghcr.io/denoland/celld:v0.3.0
ARG NODE_IMAGE=docker.io/library/node@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2

FROM ${CELLD_IMAGE} AS celld
FROM ${NODE_IMAGE}

ARG ESBUILD_VERSION=0.28.1
RUN npm install --global "esbuild@${ESBUILD_VERSION}" && npm cache clean --force
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld

ENTRYPOINT ["celld"]
