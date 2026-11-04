# The image every bridge sandbox starts from. Swap FROM for the base your commands need
# (keep a linux/amd64 image with sh and GNU coreutils `timeout`).
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git python3 \
	&& rm -rf /var/lib/apt/lists/*

# Helper that @cloudflare/sandbox's Files class runs. The tag MUST match the
# @cloudflare/sandbox version in package.json, or file calls fail with SandboxProtocolError.
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
