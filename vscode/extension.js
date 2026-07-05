'use strict';
/**
 * claude-lens VS Code extension.
 *
 * Contributes an Activity Bar container with a native tree of Claude Code
 * sessions (grouped by project, titled from each session's own AI title),
 * plus a webview panel hosting the same viewer UI as the CLI
 * (public/index.html). The webview talks to this host over postMessage;
 * the host answers from ~/.claude/projects via lib/scan.js.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const scan = require('../lib/scan.js');

let panel = null;
let panelReady = false;
let pendingOpen = null;

function applyProjectsDirSetting() {
  // Empty setting → scan.js default (~/.claude/projects or $CLAUDE_CONFIG_DIR/projects)
  scan.setRoot(vscode.workspace.getConfiguration('claudeLens').get('projectsDir') || null);
}

function activate(context) {
  applyProjectsDirSetting();
  const tree = new SessionTreeProvider();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeLens.projectsDir')) {
        applyProjectsDirSetting();
        tree.refresh();
      }
    }),
    vscode.window.registerTreeDataProvider('claudeLens.sessions', tree),
    vscode.commands.registerCommand('claudeLens.open', () => openPanel(context)),
    vscode.commands.registerCommand('claudeLens.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('claudeLens.openSession',
      (project, file) => openPanel(context, { project, file })),
    vscode.commands.registerCommand('claudeLens.resumeSession', resumeFromTree),
    vscode.commands.registerCommand('claudeLens.copyResumeCommand', copyResumeFromTree),
    vscode.window.registerWebviewViewProvider('claudeLens.dashboard', new DashboardProvider(context)),
  );
}

/** `cd <cwd> && claude --resume <id>`, or null if the id is unusable. */
function resumeCommandString(sessionId, cwd) {
  if (!/^[A-Za-z0-9-]{4,64}$/.test(String(sessionId || ''))) return null;
  const cd = cwd ? `cd '${String(cwd).replace(/'/g, "'\\''")}' && ` : '';
  return cd + 'claude --resume ' + sessionId;
}

async function sessionCwd(projectSlug, file) {
  try {
    return (await scan.sessionMeta(path.join(scan.getRoot(), projectSlug, file))).cwd;
  } catch { return null; }
}

async function copyResumeFromTree(el) {
  if (!el || el.kind !== 'sess') return;
  const cmd = resumeCommandString(el.s.id, await sessionCwd(el.p.slug, el.s.file));
  if (!cmd) return void vscode.window.showWarningMessage('claude-lens: unusable session id');
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.setStatusBarMessage('claude-lens: resume command copied', 3000);
}

/** Open a terminal in the session's cwd and run `claude --resume`. */
function resumeInTerminal(sessionId, cwd) {
  // The id and cwd come from transcript files; only a strict uuid-like
  // token may ever reach the terminal, and cwd must exist on disk.
  if (!/^[A-Za-z0-9-]{4,64}$/.test(sessionId)) {
    vscode.window.showWarningMessage('claude-lens: unusable session id');
    return false;
  }
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  const term = vscode.window.createTerminal({ name: 'claude resume', cwd: dir });
  term.show();
  term.sendText(`claude --resume ${sessionId}`, true);
  return true;
}

async function resumeFromTree(el) {
  if (!el || el.kind !== 'sess') return;
  resumeInTerminal(el.s.id, await sessionCwd(el.p.slug, el.s.file));
}

/* ------------------------------------------------------- session tree */

function relTime(t) {
  const d = Date.now() - t;
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + 'm ago';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
  if (d < 7 * 86400e3) return Math.round(d / 86400e3) + 'd ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Today", "Yesterday", weekday within a week, else a short date. */
function dateBucket(t) {
  const d = new Date(t), now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86400e3);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Recency → theme color for the session icon. */
function ageColor(mtime) {
  const days = (Date.now() - mtime) / 86400e3;
  if (days < 1) return new vscode.ThemeColor('charts.orange');
  if (days < 2) return new vscode.ThemeColor('charts.yellow');
  if (days < 7) return new vscode.ThemeColor('charts.blue');
  return undefined; // default muted foreground
}

class SessionTreeProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }

  refresh() { this._em.fire(undefined); }

  async getChildren(el) {
    if (!el) {
      const projects = await scan.listProjects();
      return projects.map((p, i) => ({ kind: 'proj', p, first: i === 0 }));
    }
    if (el.kind === 'proj') {
      // group the project's sessions into date buckets
      const buckets = [];
      let cur = null;
      for (const s of el.p.sessions) {
        const label = dateBucket(s.mtime);
        if (!cur || cur.label !== label) {
          cur = { kind: 'bucket', label, p: el.p, sessions: [] };
          buckets.push(cur);
        }
        cur.sessions.push(s);
      }
      return buckets;
    }
    if (el.kind === 'bucket') return el.sessions.map((s) => ({ kind: 'sess', p: el.p, s }));
    return [];
  }

  async getTreeItem(el) {
    if (el.kind === 'proj') {
      const short = el.p.name.split('/').slice(-2).join('/');
      const it = new vscode.TreeItem(short, el.first
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = String(el.p.sessions.length);
      it.tooltip = el.p.name;
      it.iconPath = vscode.ThemeIcon.Folder;
      return it;
    }
    if (el.kind === 'bucket') {
      const it = new vscode.TreeItem(el.label, el.label === 'Today'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = String(el.sessions.length);
      it.iconPath = new vscode.ThemeIcon('calendar', ageColor(el.sessions[0].mtime));
      return it;
    }
    const { p, s } = el;
    let meta = {};
    try { meta = await scan.sessionMeta(path.join(scan.getRoot(), p.slug, s.file)); } catch { /* uuid label */ }
    const it = new vscode.TreeItem(meta.title || meta.firstPrompt || s.id.slice(0, 8) + '…');
    it.description = relTime(s.mtime);
    it.tooltip = [meta.title, meta.firstPrompt, new Date(s.mtime).toLocaleString()]
      .filter(Boolean).join('\n');
    it.iconPath = new vscode.ThemeIcon('comment-discussion', ageColor(s.mtime));
    it.contextValue = 'session';
    it.command = {
      command: 'claudeLens.openSession',
      title: 'Open session',
      arguments: [p.slug, s.file],
    };
    return it;
  }
}

/* ------------------------------------------------------ viewer panel */

function openPanel(context, sel) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    if (sel) {
      if (panelReady) panel.webview.postMessage({ cmd: 'open', ...sel });
      else pendingOpen = sel;
    }
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'claudeLens',
    'Claude Lens',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panelReady = false;
  pendingOpen = sel || null;
  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'lens.svg'));
  panel.onDidDispose(() => { panel = null; panelReady = false; }, null, context.subscriptions);

  let html = fs.readFileSync(path.join(context.extensionPath, 'public', 'index.html'), 'utf8');
  // Follow the editor theme instead of the OS preference.
  const dark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
  html = html.replace('<html lang="en">', `<html lang="en" data-theme="${dark ? 'dark' : 'light'}">`);
  html = html.replace('__LENS_VERSION__', 'v' + require('../package.json').version);
  panel.webview.html = html;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.cmd === 'ready') {
      panelReady = true;
      if (pendingOpen) {
        panel.webview.postMessage({ cmd: 'open', ...pendingOpen });
        pendingOpen = null;
      }
      return;
    }
    const reply = (ok, data, error) => panel && panel.webview.postMessage({ id: msg.id, ok, data, error });
    try {
      if (msg.cmd === 'projects') {
        reply(true, { root: scan.getRootDisplay(), single: false, projects: await scan.listProjects() });
      } else if (msg.cmd === 'meta') {
        const f = scan.resolveSession(msg.args.project, msg.args.file);
        if (!f) return reply(false, null, 'bad path');
        reply(true, await scan.sessionMeta(f));
      } else if (msg.cmd === 'session') {
        const f = scan.resolveSession(msg.args.project, msg.args.file);
        if (!f) return reply(false, null, 'bad path');
        reply(true, await fs.promises.readFile(f, 'utf8'));
      } else if (msg.cmd === 'resume') {
        if (!resumeInTerminal(String(msg.args.sessionId || ''), msg.args.cwd)) {
          return reply(false, null, 'bad session id');
        }
        reply(true, true);
      } else {
        reply(false, null, 'unknown command');
      }
    } catch (err) {
      reply(false, null, String(err && err.message || err));
    }
  }, null, context.subscriptions);
}

/* --------------------------------------------- panel-area dashboard */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class DashboardProvider {
  constructor(context) { this.context = context; }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.onDidChangeVisibility(() => { if (view.visible) this.render(); });
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.cmd === 'open') {
        vscode.commands.executeCommand('claudeLens.openSession', msg.project, msg.file);
      } else if (msg.cmd === 'resume') {
        resumeInTerminal(msg.sessionId, msg.cwd || (await sessionCwd(msg.project, msg.file)));
      } else if (msg.cmd === 'copy') {
        const cmd = resumeCommandString(msg.sessionId, msg.cwd || (await sessionCwd(msg.project, msg.file)));
        if (cmd) {
          await vscode.env.clipboard.writeText(cmd);
          vscode.window.setStatusBarMessage('claude-lens: resume command copied', 3000);
        }
      } else if (msg.cmd === 'refresh') {
        this.render();
      }
    }, null, this.context.subscriptions);
    this.render();
  }

  async render() {
    if (!this.view) return;
    let projects = [];
    try { projects = await scan.listProjects(); } catch { /* empty state below */ }

    const all = [];
    for (const p of projects) for (const s of p.sessions) all.push({ p, s });
    all.sort((a, b) => b.s.mtime - a.s.mtime);

    // 14-day activity: sessions touched + bytes written per day
    const days = Array.from({ length: 14 }, () => ({ n: 0, bytes: 0 }));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    for (const { s } of all) {
      const d = Math.floor((midnight.getTime() + 86400e3 - s.mtime) / 86400e3);
      if (d >= 0 && d < 14) { days[13 - d].n++; days[13 - d].bytes += s.size; }
    }
    const today = days[13], week = days.slice(7).reduce((a, d) => a + d.n, 0);
    const max = Math.max(1, ...days.map(d => d.n));
    const fmtMB = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

    const recent = all.slice(0, 8);
    const metas = await Promise.all(recent.map(({ p, s }) =>
      scan.sessionMeta(path.join(scan.getRoot(), p.slug, s.file)).catch(() => ({}))));

    const rel = (t) => {
      const d = Date.now() - t;
      if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + 'm';
      if (d < 86400e3) return Math.round(d / 3600e3) + 'h';
      return Math.round(d / 86400e3) + 'd';
    };

    const bars = days.map((d, i) => {
      const h = d.n ? Math.max(8, Math.round(d.n / max * 100)) : 4;
      const label = new Date(midnight.getTime() - (13 - i) * 86400e3)
        .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      return `<div class="bar${d.n ? '' : ' zero'}${i === 13 ? ' today' : ''}" style="height:${h}%"
        title="${esc(label)}: ${d.n} session${d.n === 1 ? '' : 's'} · ${fmtMB(d.bytes)}"></div>`;
    }).join('');

    const rows = recent.map(({ p, s }, i) => {
      const m = metas[i] || {};
      const title = m.title || m.firstPrompt || s.id.slice(0, 8) + '…';
      const proj = p.name.split('/').pop();
      const data = `data-project="${esc(p.slug)}" data-file="${esc(s.file)}" data-sid="${esc(s.id)}" data-cwd="${esc(m.cwd || '')}"`;
      return `<div class="row" ${data}>
        <span class="t" title="${esc(title)}">${esc(title)}</span>
        <span class="m">${esc(proj)} · ${rel(s.mtime)}</span>
        <span class="acts">
          <button data-act="copy" title="Copy resume command">⧉</button>
          <button data-act="resume" title="Resume in terminal">▶</button>
        </span>
      </div>`;
    }).join('');

    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground);
             margin: 0; padding: 10px 14px; user-select: none; }
      #wrap { display: flex; gap: 26px; align-items: stretch; max-width: 900px; }
      h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px;
           color: var(--vscode-descriptionForeground); font-weight: 600; }
      .stats { flex: none; display: flex; flex-direction: column; gap: 4px; min-width: 130px; }
      .stat b { font-size: 18px; font-weight: 600; }
      .stat span { color: var(--vscode-descriptionForeground); margin-left: 5px; }
      #chart { flex: none; width: 190px; display: flex; align-items: flex-end; gap: 4px; height: 74px; }
      .bar { flex: 1; background: var(--vscode-charts-orange); opacity: 0.45; border-radius: 2px 2px 0 0; min-height: 3px; }
      .bar.today { opacity: 1; }
      .bar.zero { background: var(--vscode-descriptionForeground); opacity: 0.18; }
      #recent { flex: 1; min-width: 0; }
      .row { display: flex; align-items: center; gap: 8px; padding: 2.5px 6px; border-radius: 4px; cursor: pointer; }
      .row:hover { background: var(--vscode-list-hoverBackground); }
      .row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .row .m { color: var(--vscode-descriptionForeground); flex: none; font-size: 11px; }
      .acts { flex: none; visibility: hidden; }
      .row:hover .acts { visibility: visible; }
      .acts button { background: none; border: none; color: var(--vscode-foreground);
                     cursor: pointer; font-size: 12px; padding: 0 4px; opacity: 0.75; }
      .acts button:hover { opacity: 1; }
      .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; }
    </style></head><body>
    ${all.length ? `<div id="wrap">
      <div class="stats">
        <h3>Claude Code</h3>
        <div class="stat"><b>${today.n}</b><span>today · ${fmtMB(today.bytes)}</span></div>
        <div class="stat"><b>${week}</b><span>this week</span></div>
        <div class="stat"><b>${all.length}</b><span>total sessions</span></div>
      </div>
      <div><h3>14 days</h3><div id="chart">${bars}</div></div>
      <div id="recent"><h3>Recent</h3>${rows}</div>
    </div>` : '<div class="empty">No Claude Code sessions found. They appear here once you use the Claude Code CLI.</div>'}
    <script>
      const vs = acquireVsCodeApi();
      document.addEventListener('click', (e) => {
        const row = e.target.closest('.row');
        if (!row) return;
        const d = row.dataset;
        const act = e.target.closest('button')?.dataset.act;
        if (act === 'copy') vs.postMessage({ cmd: 'copy', sessionId: d.sid, cwd: d.cwd, project: d.project, file: d.file });
        else if (act === 'resume') vs.postMessage({ cmd: 'resume', sessionId: d.sid, cwd: d.cwd, project: d.project, file: d.file });
        else vs.postMessage({ cmd: 'open', project: d.project, file: d.file });
      });
    </script></body></html>`;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
