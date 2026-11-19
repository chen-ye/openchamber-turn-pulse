# Turn Pulse extension for OpenChamber

Shows real-time OpenCode turn execution phases, streaming token velocity, and proportional phase timing in OpenChamber's Work Status panel.

## Setup

1. Ensure you are running OpenChamber `>=2.7.0`. No extra CLIs or configuration are required.
2. In OpenChamber **Settings → Extensions**, add or enable the `turn-pulse` extension directory.

## Using Turn Pulse in OpenChamber

### Work Status panel

The **Turn Pulse** section updates every second while you work in OpenChamber:

- **Headline and timers**: Displays the current turn phase—including step number, active tool name and target, or what the turn is waiting on—alongside `phase · total` elapsed durations while active, or the total turn duration once finished (`Turn complete` briefly, then `Idle`, or `Failed` with the error message). Hover the row for session title, agent, model, step count, initial time-to-first-token, and estimated output tokens.
- **Throughput sparkline**: Plots a 30-second rolling stream-rate chart with estimated `tok/s` (live rate while streaming, or peak `tok/s` after the turn finishes).
- **Phase breakdown bars**: Shows proportional horizontal bars and aligned durations for each stage that ran during the turn:
  - **First token** (or **LLM wait (N)** on multi-step turns): Time waiting for the model to emit its first token.
  - **Thinking**: Time spent streaming reasoning output.
  - **Tool args**: Time spent streaming tool call arguments.
  - **Tools (N)**: Time spent executing tools (and total tool count).
  - **Reply**: Time spent streaming the assistant's text reply.
  - **Blocked**: Time spent waiting on permission approvals, user questions, retry backoffs, or child subagents.
- **Parallel tools and subagents**: Lists up to 3 concurrent in-flight tools (when more than one runs at once) and up to 3 active child subagent sessions with their live phase and duration.

### Switching sessions (`Auto` vs. pinned)

When two or more root sessions in the active workspace have live or recent turn activity, a **Session** selector appears in the **Turn Pulse** header:

- **Auto** (default): Automatically follows the currently active session in the workspace, or the most recently updated session when idle.
- **Pinned session**: Select any listed session (`●` marks busy sessions) to lock the Work Status view to that chat until you switch back to **Auto**.

## Development

```bash
bun run build
bun run check
bun test
```
