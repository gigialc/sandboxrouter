# Runtime image for sandbox-routing. Runs as any numeric user with a read-only root:
# everything installs at build time, world-readable; state lives under HOME.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.19.6

# GNU tar: e2b and daytona stage the workspace with it.
# git: they track the workspace with it, and the package declares it as a tool.
# ca-certificates and curl: HTTPS from the runner and from every sandbox provider API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git tar ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The runner.
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && chmod -R a+rX "$(npm root -g)"

# node and npm, the other declared tools, come with the base image.
# The gate is a script inside the package's skill and needs nothing installed.

WORKDIR /workspace
