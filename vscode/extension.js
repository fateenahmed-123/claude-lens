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

function activate(context) {
  const tree = new SessionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeLens.sessions', tree),
    vscode.commands.registerCommand('claudeLens.open', () => openPanel(context)),
    vscode.commands.registerCommand('claudeLens.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('claudeLens.openSession',
      (project, file) => openPanel(context, { project, file })),
    vscode.commands.registerCommand('claudeLens.resumeSession', resumeFromTree),
  );
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
  let cwd = null;
  try {
    cwd = (await scan.sessionMeta(path.join(scan.PROJECTS_DIR, el.p.slug, el.s.file))).cwd;
  } catch { /* resume without cwd */ }
  resumeInTerminal(el.s.id, cwd);
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
    try { meta = await scan.sessionMeta(path.join(scan.PROJECTS_DIR, p.slug, s.file)); } catch { /* uuid label */ }
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
        reply(true, { root: scan.PROJECTS_DIR, single: false, projects: await scan.listProjects() });
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

function deactivate() {}

module.exports = { activate, deactivate };
