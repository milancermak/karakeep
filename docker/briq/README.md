# Fork deployment and development handoff

This fork has a working self-hosted deployment and is intended to support custom
capture clients, including a macOS menu bar app, and changes to retrieval and MCP
tools. Product personalization has not been implemented yet. Keep compatibility
with the standard mobile apps and browser extensions when changing the API.

## Development on another machine

- Keep the upstream tracking branch free of custom changes. Develop on the
  customization branch or feature branches, and merge selected upstream releases
  deliberately.
- Use the upstream development workflow in
  [`docs/docs/08-development/01-setup.md`](../../docs/docs/08-development/01-setup.md).
  Use a separate development database, assets directory, search index, and secrets.
  Do not run development migrations against production data.
- This directory's Compose setup targets a Linux host with Docker's **systemd
  cgroup driver**. It is not the development setup for Docker Desktop on macOS.
- Useful areas: `apps/web` for the web UI, `packages/trpc` for application logic,
  `packages/api` and `packages/sdk` for API clients, and `apps/mcp` for agent tools.
  The MCP adapter is a separate client process that calls the server API using a
  Karakeep API key. A server deployment does not update installed MCP adapters or
  published browser/mobile clients.

## Production deployment

`compose.yaml` builds this checkout using the production Dockerfile's `aio`
target, which runs the web application, migrations, and one Rust background
engine. A second fork-specific image runs the browser host; Chrome starts on
demand and exits after an idle window. Meilisearch runs separately. Architecture,
source locations, recovery semantics and development checks are documented in
[`docs/rust-engine.md`](../../docs/rust-engine.md).

The helper defaults to a **sibling directory outside the checkout**:

```text
karakeep/                  source checkout
karakeep-runtime/
  .env                     private settings and credentials
  image.env                selected image tag and source revision
  data/                    SQLite databases and saved assets
  meilisearch/             search index
```

An existing production instance uses this layout. Its private URL, credentials,
and host settings are intentionally absent from Git. Obtain connection details
privately when needed; never copy the production runtime files into the checkout.

Set `KARAKEEP_RUNTIME_DIR` to use a different runtime directory, still outside the
Docker build context. Protect the directory with mode `0700` and `.env` with mode
`0600`. `.env` contains `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `MEILI_MASTER_KEY`,
`OPENAI_API_KEY`, `DISABLE_SIGNUPS`, and `KARAKEEP_HTTP_PORT`. Generate independent
cryptographically random authentication and search secrets. The existing
production account has been created and new signups disabled.

`KARAKEEP_CHROME_IMAGE` and `KARAKEEP_SEARCH_IMAGE` can pin support images by
digest; production uses these pins. `KARAKEEP_SOURCE_URL` can optionally set a
public source URL in image metadata; never put authenticated URLs there.

The app binds only to host loopback on `KARAKEEP_HTTP_PORT`; port 3000 inside the
container stays fixed. Host-managed Tailscale Serve forwards a private HTTPS
address to that loopback port. Meilisearch and Chrome have no published host
ports. Configure the same HTTPS address in clients and `NEXTAUTH_URL`, and keep
Tailscale connected on client devices.

Run from the repository root on the production host:

```sh
./docker/briq/manage.sh config
./docker/briq/manage.sh build
./docker/briq/manage.sh up --wait --wait-timeout 120
./docker/briq/manage.sh status
./docker/briq/manage.sh stats
./docker/briq/manage.sh processes
./docker/briq/manage.sh logs -f app
```

`config` validates silently because expanded Compose output contains secrets.
`build` tags the images as `karakeep-local:<revision>-local-<UTC timestamp>` and
`karakeep-browser:<same tag>`, and selects them in `image.env` only after both
builds succeed. The revision identifies
the base commit; uncommitted local edits are also included in the build. `up`
starts the selected image without rebuilding. Rebuilding never updates the
running service by itself.

Containers are named `karakeep-app`, `karakeep-chrome`, and `karakeep-search`, with
application/role labels and a shared `karakeep.slice` cgroup. The native engine
appears as `karakeep-engine` in process monitors. Use `stats`
for container resource totals and `processes` to map host PIDs to containers.

## Current validation and remaining work

The deployment passed local and Tailscale HTTPS health checks, signup form
rendering in Chrome, external page fetching, authenticated Meilisearch access,
and small OpenAI requests for tagging, image-model access, and embeddings.
Mobile login to the instance has also been confirmed.

The OpenAI key is restricted to the endpoints used by the app: Chat Completions
and Embeddings. If a new feature gets permission errors, check its endpoint
requirements before broadening access. Karakeep API keys used by MCP and other
clients are separate from the OpenAI key.

The production Dockerfile disables pnpm's automatic dependency verification for
the web and migration build commands, matching the existing worker command.
Dependencies are already installed in the base stage; verification after copying
the full workspace was triggering additional installs in both build stages.

A consistent local backup and isolated restore are part of the Rust-engine
cutover. Off-host backups have **not** been configured. Back up the database,
saved assets, search data and private runtime configuration consistently. Keep
the prior application and Chrome image selection and Compose file together;
see the engine document for rollback steps and pending-work handling. An image
rollback alone cannot undo database migrations.
