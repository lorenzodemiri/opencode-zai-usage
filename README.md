# opencode-zai-usage

An OpenCode v2 TUI plugin that adds a sidebar section on the right showing your z.ai Coding Plan allowance: two progress bars (5-hour window and weekly limit) with percent used, reset countdowns, and your plan name. It also adds a `/zai-usage` slash command that refreshes the data and shows a summary toast. The plugin reads your key from OpenCode's own auth storage; the key never leaves your machine except as an Authorization header to api.z.ai.

The sidebar section looks like this:

```
 z.ai                    pro
 5h    ▓▓▓▓░░  63% · 1h42m
 week  ▓▓░░░░  34% · 2d5h
```

## Requirements

- OpenCode v2 (2.2.3 or newer; the plugin API and TUI slots used here do not exist in OpenCode 1.x)
- A z.ai Coding Plan subscription, with its API key configured in OpenCode. Log in to the `zai-coding-plan` provider via `opencode auth login`. The plugin reads the key from OpenCode's `auth.json` (entries `zai-coding-plan` or `zai`).
- `curl` on PATH (used as a network fallback only)

## Install

Recommended, one command with the OpenCode v2 CLI:

```sh
opencode plugin add github:lorenzodemiri/opencode-zai-usage
```

Then restart OpenCode.

Alternative, manual copy (no CLI needed):

```sh
git clone https://github.com/lorenzodemiri/opencode-zai-usage.git ~/.config/opencode/plugins/opencode-zai-usage
```

OpenCode auto-discovers plugin packages in `~/.config/opencode/plugins/`. Restart OpenCode.

### One-prompt install (paste into your agent)

```text
Install the OpenCode plugin opencode-zai-usage (z.ai Coding Plan usage sidebar):
1. Run: opencode plugin add github:lorenzodemiri/opencode-zai-usage
   If the plugin CLI is unavailable or fails, instead run:
   git clone https://github.com/lorenzodemiri/opencode-zai-usage.git ~/.config/opencode/plugins/opencode-zai-usage
2. Verify a z.ai key exists in OpenCode auth (opencode auth login on the zai-coding-plan provider if not).
3. Restart OpenCode and confirm a "z.ai" section with 5h and week bars appears in the right sidebar; run /zai-usage as a test.
```

## How it works

- Polls `GET https://api.z.ai/api/monitor/usage/quota/limit` every 5 minutes with the Bearer key from `auth.json`
- Renders the bars via a single reactive sidebar slot claim (`sidebar.content`)
- Color shifts to yellow at 80% used and red at 95%
- Uses native `fetch` with an automatic `curl` fallback (the key is passed via stdin config, never on the command line)
- Writes a debug log at `~/.local/share/opencode/zai-allowance.log`

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `ZAI_ALLOWANCE_POLL_MS` | Poll interval in milliseconds | `300000` (5 min) |

Set it as an environment variable before starting OpenCode.

## Troubleshooting

- Seeing "allowance unavailable" or no section at all: check that you are on OpenCode v2 (`opencode --version`), that the key exists in `auth.json`, and look at the log file for fetch errors.
- OpenCode 1.x silently cannot load this plugin.

## Uninstall

```sh
opencode plugin remove opencode-zai-usage
```

Or delete the copied folder from `~/.config/opencode/plugins/`.

## License

MIT.

## Disclaimer

This is an unofficial community plugin, not affiliated with or endorsed by Z.ai. It queries an undocumented usage endpoint which may change without notice.
