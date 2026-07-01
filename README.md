# Codex Feishu Bridge

A lightweight bridge that lets a Feishu bot talk to your local Codex CLI.

The bridge runs on your machine, receives Feishu messages through the official long connection API, forwards each message to `codex exec --json`, and sends Codex replies back into the same Feishu chat.

## Quick Start

1. Install Node.js 20+.
2. Install and authenticate Codex CLI:

```bash
npm install -g @openai/codex
codex login
codex --version
```

3. Create a Feishu bot app:
   - Enable bot capability.
   - Subscribe to `im.message.receive_v1`.
   - Enable event long connection mode.
   - Grant message send, image/file upload, and message resource read permissions if you want file transfer.
   - Publish the app after changing permissions or events.

4. Run the bridge setup:

```bash
git clone https://github.com/citarreikee/codex-feishu-bridge.git
cd codex-feishu-bridge
npm install
npm run build
node dist/cli.mjs setup --start
```

The setup wizard writes local config to:

```text
~/.codex-feishu-bridge/config.env
```

Secrets stay on your machine. Do not commit or share this file.

## Commands

```bash
node dist/cli.mjs setup
node dist/cli.mjs setup --start
node dist/cli.mjs start
node dist/cli.mjs stop
node dist/cli.mjs restart
node dist/cli.mjs status
node dist/cli.mjs logs 100
node dist/cli.mjs run
```

Convenience wrappers are also included:

```bash
./codex-feishu-bridge start
.\codex-feishu-bridge.ps1 start
```

## In-Chat Commands

Send these to the Feishu bot:

- `/help`
- `/status`
- `/new`
- `/reset`

The bridge keeps one Codex thread per Feishu chat. `/new` and `/reset` clear the thread binding for that chat.

## Manual Config

`setup` writes this automatically, but advanced users can edit:

```text
~/.codex-feishu-bridge/config.env
```

Common variables:

```env
CFB_FEISHU_APP_ID=cli_xxx
CFB_FEISHU_APP_SECRET=xxx
CFB_FEISHU_DOMAIN=feishu
CFB_FEISHU_REQUIRE_MENTION=true
CFB_FEISHU_USE_CARDS=false

CFB_CODEX_WORKDIR=/Users/yourname/project
CFB_CODEX_EXECUTABLE=codex
CFB_CODEX_MODEL=
CFB_CODEX_SANDBOX=danger-full-access
CFB_CODEX_APPROVAL_POLICY=never
CFB_CODEX_SKIP_GIT_REPO_CHECK=true
CFB_CODEX_BYPASS_APPROVALS_AND_SANDBOX=false
CFB_CODEX_CONFIG_OVERRIDES=
```

By default, the bridge runs:

```bash
codex exec --json --color never -C "$CFB_CODEX_WORKDIR" --skip-git-repo-check --sandbox danger-full-access --ask-for-approval never "<message>"
```

For an existing chat thread, it runs:

```bash
codex exec resume <thread-id> --json --color never -C "$CFB_CODEX_WORKDIR" "<message>"
```

Leave `CFB_CODEX_MODEL` empty to use your Codex default model. Set it only when you want the bridge to pass `--model`.

Use `CFB_CODEX_CONFIG_OVERRIDES` for comma-separated Codex `-c key=value` overrides.

## File Transfer

When a Feishu user sends an image, file, audio, or video message, the bridge downloads it locally and appends the file path to the Codex prompt.

Default inbound path:

```text
~/.codex-feishu-bridge/data/attachments/<chat-id>/<message-id>/
```

To send files back to the current Feishu chat, Codex can write:

```text
~/.codex-feishu-bridge/outbox/<chat-id>/send.json
```

Manifest shape:

```json
{
  "files": [
    {
      "path": "/absolute/path/to/report.pdf",
      "caption": "Optional text sent before the file"
    }
  ]
}
```

The bridge uploads each file after the Codex turn and renames the manifest to a `.sent` file. By default, outbound files are only allowed from `CFB_CODEX_WORKDIR` and the bridge outbox directory.

## What It Can Do

- Receive Feishu messages through official long connection events.
- Forward each message to local Codex CLI.
- Keep one Codex thread per Feishu chat.
- Stream Codex agent messages back to Feishu.
- Send plain text by default, with optional Feishu cards.
- Download Feishu image/file/audio/video messages to local paths.
- Send local files back when Codex writes an outbox manifest.

## Troubleshooting

If the bot does not reply, check:

- The bridge is running: `node dist/cli.mjs status`.
- Logs do not show auth errors: `node dist/cli.mjs logs 100`.
- The Feishu app is published.
- `im.message.receive_v1` is subscribed.
- Long connection mode is enabled.
- App ID and App Secret are correct.
- The local machine can run `codex --version`.
- Codex is logged in: `codex login`.

## Security Notes

- Never commit `~/.codex-feishu-bridge/config.env`.
- Never share your Feishu App Secret or OpenAI credentials.
- Treat the machine running this bridge as trusted.
- `CFB_CODEX_SANDBOX=danger-full-access` and `CFB_CODEX_APPROVAL_POLICY=never` are convenient for a chat bridge but broad. Narrow them if you need stricter local controls.
- Keep `CFB_FILE_SEND_ROOTS` narrow. Files outside those roots will not be uploaded to Feishu.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
