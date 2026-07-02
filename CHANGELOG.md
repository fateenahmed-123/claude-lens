# Changelog

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
