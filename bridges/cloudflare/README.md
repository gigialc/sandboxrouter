# sandboxrouter bridge for Cloudflare Sandboxes

Cloudflare sandboxes are [Containers](https://developers.cloudflare.com/containers/) that a Durable Object starts, so only code running inside a Worker can drive them. This folder holds a small Worker that you deploy to your own Cloudflare account. sandboxrouter's `cloudflare` provider calls it over HTTPS.

It uses Sandbox SDK 1.0 (`@cloudflare/sandbox@1.0.3`). Commands go through `ctx.container.exec()`, and file reads and writes go through the SDK's `Files` class. The 0.x `getSandbox()` API is not used.

## Requirements

- A Cloudflare account on the **Workers Paid** plan. Containers are not available on Free.
- Docker running locally. `wrangler deploy` builds the image in `Dockerfile` (check with `docker info`).
- Node 20 or later.

## Deploy

```sh
cd bridges/cloudflare
npm install
npx wrangler login               # once
npx wrangler deploy              # builds the image and prints https://sandboxrouter-bridge.<subdomain>.workers.dev
openssl rand -hex 32             # generate a token
npx wrangler secret put BRIDGE_TOKEN   # paste the token
```

Until `BRIDGE_TOKEN` is set, every request is refused with `500 not_configured`.

Then point sandboxrouter at the bridge:

```sh
export CLOUDFLARE_SANDBOX_URL=https://sandboxrouter-bridge.<subdomain>.workers.dev
export CLOUDFLARE_SANDBOX_TOKEN=<the same token>
```

Check it:

```sh
curl -s -X POST "$CLOUDFLARE_SANDBOX_URL/sandboxes" -H "Authorization: Bearer $CLOUDFLARE_SANDBOX_TOKEN" -d '{}'
# {"id":"..."}
curl -s -X POST "$CLOUDFLARE_SANDBOX_URL/sandboxes/<id>/exec" -H "Authorization: Bearer $CLOUDFLARE_SANDBOX_TOKEN" \
  -d '{"cmd":"uname -a && python3 --version"}'
curl -s -X DELETE "$CLOUDFLARE_SANDBOX_URL/sandboxes/<id>" -H "Authorization: Bearer $CLOUDFLARE_SANDBOX_TOKEN"
```

To run it locally, use `npx wrangler dev`. It also needs Docker. Put `BRIDGE_TOKEN=...` in `.dev.vars`.

## API

Every route requires `Authorization: Bearer <BRIDGE_TOKEN>`. Errors come back as JSON `{code, message}` with the matching HTTP status.

| Route | Body | Response |
| --- | --- | --- |
| `POST /sandboxes` | `{env?, instance?, image?, timeoutMinutes?}` | `201 {id}` once the container accepts commands |
| `GET /sandboxes/:id` | | `{id, running, expiresAt}`, or `404` |
| `POST /sandboxes/:id/exec` | `{cmd, cwd?, env?, timeoutSeconds?}` | `{exitCode, stdout, stderr}` |
| `PUT /sandboxes/:id/files?path=` | raw bytes | `204`. Missing parent directories are created |
| `GET /sandboxes/:id/files?path=` | | raw bytes, or `404` |
| `DELETE /sandboxes/:id` | | `204`. Calling it again is harmless |

Startup is limited to 60 seconds. A failed start triggers cleanup; if Cloudflare is slow to stop the instance, the response waits at most another 5 seconds while cleanup continues. The hard-lifetime alarm is installed before startup and remains available to retry cleanup. A fresh deployment may need time for Cloudflare to provision container capacity.

The `POST /sandboxes` fields:

- `instance`: one of `lite`, `basic`, `standard-1` (the default), `standard-2`, `standard-3`, `standard-4`.
- `image`: a key under `containers[].images` in `wrangler.jsonc`. The default is `sandbox`.
- `timeoutMinutes`: the sandbox's hard lifetime, from 1 to 1440. The default is 30. A Durable Object alarm destroys the container when it runs out. The inactivity timeout is set to the same value, capped at Cloudflare's 6-hour maximum.

The `exec` route works like this:

- `cmd` runs as `sh -c <cmd>` under GNU `timeout`. A command that runs out of time exits with `124`, or `137` if it also had to be killed.
- A nonzero exit code is returned as a normal result, not as an error.
- `cwd` defaults to `/workspace`.
- The `env` given at creation is passed to every command, merged with the per-command `env`. `exec()` does not inherit the container's startup env.
- With `Accept: text/event-stream`, the route streams `event: stdout` and `event: stderr` events, each with a JSON string chunk as data. It ends with `event: result` carrying `{exitCode, stdout, stderr}`, or `event: error` carrying `{code, message}`. Lines that start with `:` are keep-alive comments. If the client disconnects, the bridge kills the command.

## Configuration

- **Image**: edit `Dockerfile`. Keep the `sandbox-shim` `COPY` line, and keep its tag equal to the `@cloudflare/sandbox` version in `package.json`. A mismatch makes file calls fail with `SandboxProtocolError`. The image also needs `sh` and GNU `timeout`, and should create `/workspace`.
- **Internet access**: set `"SANDBOX_INTERNET": "false"` in `wrangler.jsonc` to block outbound traffic from sandboxes.
- **Security**: the bridge runs any command a token holder sends. Treat `BRIDGE_TOKEN` like a cloud credential, and don't put Worker secrets into sandbox env.

## Cost

Containers bill per 10 ms while an instance runs, on top of the $5/month Workers Paid plan:

- CPU: $0.000020 per vCPU-second, for active CPU use only.
- Memory: $0.0000025 per GiB-second of provisioned memory.
- Disk: $0.00000007 per GB-second of provisioned disk.

Each month includes 375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk. An idle instance still pays for its memory and disk, so delete sandboxes when you're done. The Worker requests and Durable Objects are billed separately. See [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
