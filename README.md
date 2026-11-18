# ReelKeeper

ReelKeeper is a self-hosted movie library organizer. It identifies movie files,
matches metadata, and manages Kodi-compatible metadata files. It does not play
videos.

## Requirements

- Node.js 22.13.1 or later
- pnpm 12.21.0

The initial deployment target is Synology DS218play with DSM 7.2 or later.

## Workspace

- `packages/shared`: shared API schemas and types
- `packages/core`: pure domain logic
- `apps/server`: API and filesystem services
- `apps/web`: React application

## Development

```sh
corepack pnpm install
corepack pnpm test
corepack pnpm lint
corepack pnpm format:check
corepack pnpm plan:dry-run
```

The test command type-checks and builds the workspace before running Vitest.
Package tests are kept beside their source files.
Start the web development server with
`corepack pnpm --filter @reelkeeper/web dev`; it proxies `/api` requests to
`http://127.0.0.1:3000` by default. Set `REELKEEPER_API_TARGET` to use a
different local API address.
The dry-run command reads `apps/server/examples/loose-file.json` and prints a
placement plan without changing files. All planned filesystem changes require
manual approval; conflicts and ambiguous layouts produce a review result.

TMDB credentials are supplied locally through `TMDB_ACCESS_TOKEN`; copy
`.env.example` only as a reference and never commit a real token. The recognizer
can be run with:

```sh
corepack pnpm --filter @reelkeeper/server build
corepack pnpm --filter @reelkeeper/server recognize -- "Amber Coast 2004.mkv"
corepack pnpm --filter @reelkeeper/server start
```

The recognizer returns ranked candidates for manual review and does not apply
filesystem operations.

Metadata refreshes use TMDB movie details and credits to merge Kodi-compatible
NFO files while retaining unknown XML and locked fields. Existing `poster.jpg`
and `fanart.jpg` are preserved by default. Every NFO or image write is
approval-gated, backed up outside the library, and checked before undo so later
user edits are not overwritten.

The watcher polls the library and persists inbox items in SQLite. By default it
checks every 5 seconds and requires 3 consecutive unchanged size/mtime samples
(about 15 seconds) before running TMDB recognition. These timings can be changed
with `WATCHER_POLL_INTERVAL_SECONDS` and `WATCHER_STABILITY_SECONDS`. Recognition
stores candidates for review and never moves or renames files; folders with
multiple videos are marked for manual review. The persisted recognition queue
processes one video at a time and recovers interrupted work after restart.
The server exposes health, inbox, and SSE endpoints and listens on
`127.0.0.1:3000` by default; `REELKEEPER_HOST` and `REELKEEPER_PORT` can
override that binding. Read endpoints are `GET /api/health`, `GET /api/inbox`,
`GET /api/inbox/:id`, and `GET /api/library`. `POST /api/inbox/:id/rematch`
replaces that item's candidates without moving or renaming files.
`GET /api/events` streams an initial inbox snapshot and full `inbox.updated`
events. The web app provides Inbox, Library, and item-detail views, including
manual candidate rematching. The item detail supports editing Kodi NFO fields
and locking manually curated fields against future metadata refreshes. Each
approved write is backed up and can be reviewed or safely undone from
Cronologia. The API reads and updates metadata at
`/api/inbox/:id/metadata`, lists the latest 100 operation batches at
`GET /api/history`, and requires explicit approval at
`POST /api/history/:id/undo`.

## NAS data and filesystem safety

Set `REELKEEPER_DATA_DIR` to a NAS-local directory such as
`/volume1/appdata/reelkeeper`; the SQLite database and operation log must stay
outside the movie-library root. Set `MOVIE_LIBRARY_ROOT` to the library path
when starting the server. Numbered SQL migrations are stored in
`apps/server/migrations`.

The scanner is non-recursive and ignores symbolic links. The executor accepts
only explicitly approved plans, records operations before applying them, and
undoes completed operations in reverse order. File writes use temporary files
and reversible backups. If undo encounters an occupied path, a modified output,
or a damaged backup, it stops without overwriting user data.

## Synology DSM deployment

The deployment helpers in `deploy/synology` target the DS218play's ARM64
Node.js 22 runtime. Build the server and web app from a clean checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @reelkeeper/server build
corepack pnpm --filter @reelkeeper/web build
```

Copy the workspace, including the generated `dist` directories and
`pnpm-lock.yaml`, to the NAS install directory. Do not copy Windows
`node_modules`. On the NAS, install production dependencies so native modules
are selected for its Linux ARM64 runtime:

```sh
cd /volume1/appdata/reelkeeper/app
corepack pnpm install --prod --frozen-lockfile --filter @reelkeeper/server...
```

If `better-sqlite3` cannot load on the NAS, stop deployment and resolve the
native-module/runtime mismatch before starting ReelKeeper; an x64 or Windows
`node_modules` directory is not compatible.

Copy `deploy/synology/reelkeeper.env.example` to
`/volume1/appdata/reelkeeper/reelkeeper.env`, set the real TMDB token, movie
root, install directory, and Node.js executable path, then restrict the file:

```sh
chmod 600 /volume1/appdata/reelkeeper/reelkeeper.env
/bin/sh /volume1/appdata/reelkeeper/app/deploy/synology/runtime-check.sh
/bin/sh /volume1/appdata/reelkeeper/app/deploy/synology/reelkeeper-service.sh start
curl -fsS http://127.0.0.1:3000/api/health
```

`runtime-check.sh` verifies Node.js 22, ARM64, and the native SQLite binding.
Use DSM Task Scheduler to run `reelkeeper-service.sh start` at boot and
`backup.sh` daily. The backup pauses ReelKeeper briefly, archives the SQLite
database and reversible operation backups consistently, and retains 14 days
of local archives under `REELKEEPER_DATA_DIR/deployment-backups`. Keep a copy
on a separate device and periodically verify a restore.

The API has no built-in authentication and must not be exposed directly to the
LAN. Keep its loopback binding. If remote access is needed, host
`apps/web/dist` with Web Station (including SPA fallback to `index.html`) and
configure the Synology reverse proxy to route `/api` to
`http://127.0.0.1:3000` and the UI to the static site. Require HTTPS and an
appropriate access-control profile. A live DSM installation, reverse-proxy
configuration, and ARM64 native-module smoke test have not been performed in
this workspace.
