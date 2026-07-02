# claude-lens

A rich, minimal viewer for [Claude Code](https://claude.com/claude-code) CLI session transcripts.

Claude Code records every session as a JSONL file under `~/.claude/projects/`. claude-lens turns those machine logs into a readable record: what you asked, what Claude thought, every tool call with its result, diffs for edits, subagent runs, token totals, and timing. All local, zero dependencies.

## Use it

```bash
npx claude-lens          # scans ~/.claude/projects, opens the viewer
```

Or point it at one transcript:

```bash
npx claude-lens ~/.claude/projects/<project>/<session>.jsonl
```

Flags: `--port N` (default 7777), `--no-open`.

You can also just open the viewer and **drag any `.jsonl` transcript onto the page**; it parses in the browser, so it works even without the file being under `~/.claude/projects`.

### In the viewer

- Sessions are grouped by project in the sidebar, newest first, titled from the session's own AI title (or first prompt).
- Tool calls and thinking are collapsed rows; click to expand. Edits render as diffs, Bash shows command and output, errors are flagged.
- `j` / `k` jump between your prompts. The filter box hides non-matching turns.
- Header shows model, prompt/tool counts, input · cache · output tokens, wall-clock span, and active time.
- Light and dark follow your system; the Theme button overrides.

### Back into Claude Code

- **Resume** — restores the session in Claude Code. In the browser it copies the ready-to-paste command (`cd <project> && claude --resume <session-id>`); in the VS Code extension it opens a terminal in the project directory and runs it for you.
- **Copy context** — builds a compact markdown digest of the whole session (your prompts, Claude's answers, one-line tool summaries; ~2% the size of the raw transcript) and copies it. Paste it into a *new* Claude Code session to carry the context over — useful when the original session is too old or too heavy to resume directly.

## VS Code extension

The extension adds a **Claude Lens icon to the Activity Bar** (the left rail): a native tree of your projects and sessions, titled and sorted newest-first, with a refresh button. Clicking a session opens the full viewer in an editor tab — the same UI as the CLI, following your editor theme. There, Resume opens a terminal in the session's project directory and runs `claude --resume` for you.

Run from source: open this folder in VS Code and press `F5` (Extension Development Host), then run the command **Claude Lens: Open Session Viewer** from the palette.

Install it locally:

```bash
npx @vscode/vsce package
code --install-extension claude-lens-0.1.0.vsix
```

### Publishing to the Marketplace

One-time setup:

1. Create a publisher at <https://marketplace.visualstudio.com/manage> (sign in with a Microsoft account). The publisher ID must match the `publisher` field in `package.json`.
2. Create a Personal Access Token in Azure DevOps (<https://dev.azure.com>, any organization): scope **Marketplace → Manage**.

Then:

```bash
npx @vscode/vsce login <publisher-id>   # paste the PAT
npx @vscode/vsce publish                # or: vsce publish patch|minor|major
```

Alternatively skip the CLI: `npx @vscode/vsce package` and upload the `.vsix` on the manage page. To reach Cursor/VSCodium users too, also publish to Open VSX: `npx ovsx publish` (token from open-vsx.org).

## Privacy & security

Your transcripts often contain source code, credentials you pasted, and internal
context. claude-lens is built so none of it leaves your machine:

- **Fully local.** No telemetry, no analytics, no network calls to anything but
  `127.0.0.1`. The npm package and the extension have **zero dependencies**, so
  there is no supply chain to audit beyond this repo.
- **Loopback only.** The CLI server binds to `127.0.0.1` and rejects requests
  whose `Host` header isn't localhost, which blocks DNS-rebinding attacks from
  web pages you happen to have open.
- **Transcript content is treated as untrusted.** Everything is HTML-escaped
  before rendering, image data URIs are sanitized to the base64 alphabet, only
  `https?:` links are linkified, and the page ships a CSP that forbids all
  external loads.
- **Path traversal guarded.** The API validates project/file names and confines
  reads to `~/.claude/projects`; the test suite covers the encoded variants.
- **Resume is validated.** Session ids come from transcript files, so only a
  strict uuid-shaped token can ever reach a terminal command.

Run the checks yourself: `npm test` (14 assertions, includes live server tests).

## How it works

- `bin/claude-lens.js` — dependency-free HTTP server: static UI + `/api/projects`, `/api/meta`, `/api/session` (paths validated against `~/.claude/projects`; binds to `127.0.0.1` only).
- `lib/scan.js` — shared scanning: project-slug decoding (filesystem-aware, since slugs are ambiguous), cheap title extraction reading only the head and tail of each file.
- `public/index.html` — the whole UI, self-contained vanilla JS. Parses JSONL client-side; heavy content (tool results, thinking) renders lazily on expand, so multi-megabyte sessions stay snappy.
- `vscode/extension.js` — hosts the same HTML in a webview, answering data requests over `postMessage` instead of HTTP.

## Transcript format notes

Each JSONL line is a typed entry. The ones the viewer renders:

| type | meaning |
|---|---|
| `user` | your prompts, and `tool_result` blocks paired back to their tool call |
| `assistant` | `text`, `thinking`, and `tool_use` content blocks, plus per-request token `usage` |
| `system` | `turn_duration` markers (turn dividers) and away summaries |
| `ai-title` / `summary` | session title |
| `isSidechain: true` entries | subagent runs, folded into an "agent" group |

Token totals are deduplicated by `requestId`, since one API response logs several assistant entries sharing the same usage.

## License

MIT
