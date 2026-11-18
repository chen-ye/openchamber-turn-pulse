# Turn Pulse

OpenChamber host service extension powered by `@openchamber/sdk` (`2.7.0`, targeting OpenChamber `>=2.7.0`). Inspects OpenCode turn execution in real time and renders phase state, token velocity, and proportional phase timing in OpenChamber's Work Status panel.

## How it works

- **Host Service (`service/main.js`)**: Runs as an authenticated loopback HTTP service (`127.0.0.1:$OPENCHAMBER_SERVICE_PORT`, Bearer auth via `OPENCHAMBER_SERVICE_TOKEN`).
- **OpenCode Event Stream & Hydration**: Subscribes to `$OPENCHAMBER_OPENCODE_URL/api/event` (SSE) and hydrates session metadata from `/api/session`, `/api/session/active`, `/api/session/:id`, and `/api/session/:id/message`.
- **Work Status Endpoint (`/status`)**: Polled by OpenChamber every `1000ms` (`GET /status?directory=...`) and accepts control actions (`POST /status`) for switching or pinning the inspected workspace session (`Auto` or a specific session). Also serves `GET /health`.

## Tracked phases & status view

- **Turn Phases**: Tracks `waiting-first-token`, `reasoning`, `tool-input`, `tool-running`, `waiting-permission`, `waiting-question`, `streaming-text`, `compacting`, `retrying`, `finalizing`, `subagent-wait`, `cooldown` (2s), `idle`, and `failed`.
- **Headline & Timers**: Displays the current phase (including step count, active tool, or block reason) alongside phase and total turn durations.
- **Throughput Sparkline**: Plots a 30-second rolling stream-rate chart with aligned `tok/s` estimates (derived from streamed characters).
- **Phase Breakdown Bars**: Shows proportional horizontal bars and tabular-aligned durations for `First token` / `LLM wait`, `Thinking`, `Tool args`, `Tools`, `Reply`, and `Blocked`.
- **Concurrency & Subagents**: Lists parallel in-flight tools (when more than one tool runs concurrently) and active child subagent sessions.

## Layout

- `index.ts` — Re-exports `service/main.ts`.
- `service/main.ts` — Turn state machine, SSE client, status view builder, and HTTP server.
- `service/main.js` — Bundled Node host entrypoint loaded by OpenChamber (kept tracked for direct extension loading).
- `service/main.test.ts` — Unit tests covering multi-step turn transitions, subagent wait, session switcher selection, and tabular layout alignment.

## Development

```bash
bun install
bun run build        # Bundles service/main.ts -> service/main.js
bun run check        # Validates extension manifest and entry points
bun check --no-script
bun test             # Runs unit tests in service/main.test.ts
```
