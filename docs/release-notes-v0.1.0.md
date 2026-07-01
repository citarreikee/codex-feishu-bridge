# Codex Feishu Bridge v0.1.0

Initial public release of a lightweight Feishu bridge for local Codex CLI.

## Highlights

- Connect a Feishu bot directly to your local `codex` CLI.
- Keep one Codex thread per Feishu chat.
- Resume previous Codex threads when possible.
- Stream Codex agent messages back as Feishu messages.
- Support Feishu long connection events.
- Support inbound and outbound local file transfer.

## Requirements

- Node.js 20+
- Local Codex CLI installed and authenticated
- Feishu bot app with long connection events enabled

## Source Install

```bash
git clone https://github.com/citarreikee/codex-feishu-bridge.git
cd codex-feishu-bridge
npm install
npm run build
node dist/cli.mjs setup --start
```

## Notes

- Config is stored under `~/.codex-feishu-bridge/config.env`.
- The bridge uses local Codex auth by default.
- File transfer is local to the machine running the bridge.
