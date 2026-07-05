# Changelog

## 0.4.10

- Usage metrics in the panel dashboard: tokens and estimated cost (at API
  rates, computed from local logs) for today and the last 30 days, plus top
  model. Full-file scans are cached per session file, so only new/changed
  sessions are re-read.
- Cross-session search in the panel dashboard: type to filter every session
  on the machine by title, first prompt, or project, with match
  highlighting; click a result to open it, or copy/resume inline. The list
  fills the panel height and scrolls.

## 0.4.6

- Panel-area dashboard (next to Terminal/Ports): today/this-week/total
  session stats, a 14-day activity chart, and recent sessions with
  open / copy-resume-command / resume-in-terminal actions.
- "Copy Resume Command" on every session in the tree (inline icon and
  right-click), copying `cd <project> && claude --resume <id>`.

## 0.4.5

- Custom sessions locations: `CLAUDE_CONFIG_DIR` is honored automatically,
  `--dir <path>` on the CLI and the `claudeLens.projectsDir` setting in
  VS Code override the root explicitly. A flat folder of `.jsonl` files
  works too (shown as one project). The sidebar footer shows the active root.
- Dark theme moved from warm brown to near-black graphite (0.4.4).

## 0.4.2

- Navigation rail for long sessions: one tick per prompt on the right edge;
  hover previews the prompt, click jumps to it, scroll tracks your position.
- Sessions tree groups by date (Today/Yesterday/weekday/date) with
  recency-tinted icons (orange today, yellow yesterday, blue this week).
- Sidebar is now fixed; it no longer scrolls away on long transcripts.
- Version badge in the UI reads package.json instead of a hardcoded string.

## 0.4.1

- Package renamed to `claude-lens-viewer` (the name `claude-lens` is taken
  on both the Marketplace and npm). Display name stays "Claude Lens"; the
  CLI command stays `claude-lens`.

- README screenshots (dark, light, expanded) captured from a synthetic demo.
- `demo/demo-session.jsonl` ships in the package: try the viewer with
  `npx claude-lens demo/demo-session.jsonl`, no real sessions needed.
- URL parameters `?theme=dark|light` and `&expand=1`.
- Marketplace publisher set to `fahmed`.

## 0.4.0

- Security hardening: Host-header check on the local server (blocks DNS
  rebinding), sanitized image data URIs, stricter static-file resolution,
  Content-Security-Policy on the viewer page.
- Empty-state welcome in the Sessions view for machines with no sessions yet.
- Dependency-free test suite (`npm test`) with a synthetic transcript fixture.

## 0.3.x

- Activity Bar container with a native Sessions tree (projects → sessions,
  real titles, refresh).
- Resume from the tree: inline terminal button and right-click
  "Resume in Terminal", opening in the session's original working directory.
- "f" monogram identity across Activity Bar, Marketplace icon, and favicon.

## 0.2.0

- VS Code extension: the viewer in a webview panel over a postMessage bridge.
- Sidebar arrangements: By date / By project, with date group headers.
- Resume button and "Copy context" digest in the viewer.

## 0.1.0

- Initial release: zero-dependency CLI server plus a self-contained viewer for
  Claude Code JSONL transcripts. Collapsible tool calls and thinking, edit
  diffs, subagent folding, token stats, drag-and-drop.
