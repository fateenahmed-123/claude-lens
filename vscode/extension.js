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
const os = require('os');
const path = require('path');
const cp = require('child_process');
const scan = require('../lib/scan.js');

let panel = null;
let panelReady = false;
let pendingOpen = null;

const RECENT_KEY = 'lens.recentOpened.v1';
const RECENT_MAX = 25;

/** Record a session as recently viewed (most-recent first, deduped by path). */
async function recordRecent(context, project, file) {
  let title = null, cwd = null;
  try {
    const m = await scan.sessionMeta(scan.resolveSession(project, file));
    title = m.title || m.firstPrompt || null;
    cwd = m.cwd || null;
  } catch { /* keep nulls */ }
  const list = (context.globalState.get(RECENT_KEY, []) || [])
    .filter((r) => !(r.project === project && r.file === file));
  list.unshift({ project, file, title, cwd, ts: Date.now() });
  await context.globalState.update(RECENT_KEY, list.slice(0, RECENT_MAX));
}

/** Recently-viewed entries whose files still exist, most-recent first. */
function getRecent(context) {
  return (context.globalState.get(RECENT_KEY, []) || []).filter((r) => {
    if (!r || !r.project || !r.file) return false;
    const fp = scan.resolveSession(r.project, r.file);
    return fp && fs.existsSync(fp);
  });
}

/** QuickPick of recently viewed sessions → reopen the chosen one. */
async function reopenRecent(context) {
  const recent = getRecent(context);
  if (!recent.length) {
    vscode.window.showInformationMessage('claude-lens: no recently viewed sessions yet.');
    return;
  }
  const items = recent.map((r) => ({
    label: '$(comment-discussion) ' + (r.title || r.file.replace(/\.jsonl$/, '').slice(0, 8) + '…'),
    description: r.project.replace(/^-/, '').split('-').pop() + ' · ' + relTime(r.ts),
    detail: r.cwd || undefined,
    r,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Reopen a recently viewed session',
    placeHolder: 'Sessions you opened recently, newest first',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) openPanel(context, { project: pick.r.project, file: pick.r.file });
}

// A CLAUDE_CONFIG_DIR/projects location detected from the login shell (the GUI
// process usually doesn't inherit shell env), merged in when nothing explicit
// is configured. Null until detectConfigDirRoot() resolves.
let autoConfigRoot = null;

function applyProjectsDirSetting() {
  // Explicit config always wins. `projectsDirs` (array) is the multi-location
  // option; `projectsDir` (string) is kept for back-compat.
  const cfg = vscode.workspace.getConfiguration('claudeLens');
  const configured = [].concat(cfg.get('projectsDirs') || [], cfg.get('projectsDir') || [])
    .filter((d) => typeof d === 'string' && d.trim());
  if (configured.length) { scan.setRoots(configured); return; }
  // Otherwise: the standard ~/.claude/projects, plus a relocated
  // CLAUDE_CONFIG_DIR location if one was detected (both shown; sessions merge).
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  if (autoConfigRoot && !roots.includes(autoConfigRoot)) roots.push(autoConfigRoot);
  scan.setRoots(roots);
}

/**
 * Resolve $CLAUDE_CONFIG_DIR the way Claude Code sees it. Prefer the process
 * env; if absent (typical for GUI-launched VS Code), read it from the user's
 * login shell so the extension finds sessions the CLI would. Returns the
 * `<dir>/projects` path or null.
 */
function detectConfigDirRoot() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return Promise.resolve(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  }
  if (process.platform === 'win32') return Promise.resolve(null); // GUI inherits env
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/bash';
    cp.execFile(shell, ['-lic', 'printf %s "$CLAUDE_CONFIG_DIR"'], { timeout: 4000 }, (err, out) => {
      const v = String(out || '').trim();
      resolve(v ? path.join(v, 'projects') : null);
    });
  });
}

function activate(context) {
  applyProjectsDirSetting();
  const tree = new SessionTreeProvider();
  // Detect a relocated CLAUDE_CONFIG_DIR (login-shell env) and merge it in.
  detectConfigDirRoot().then((r) => {
    if (r && r !== autoConfigRoot) { autoConfigRoot = r; applyProjectsDirSetting(); tree.refresh(); }
  }).catch(() => { /* best-effort */ });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeLens.projectsDir')
        || e.affectsConfiguration('claudeLens.projectsDirs')) {
        applyProjectsDirSetting();
        tree.refresh();
      }
    }),
    vscode.window.registerTreeDataProvider('claudeLens.sessions', tree),
    vscode.commands.registerCommand('claudeLens.open', () => {
      // Restore the most recently viewed session rather than opening empty.
      const last = panel ? null : getRecent(context)[0];
      openPanel(context, last ? { project: last.project, file: last.file } : undefined);
    }),
    vscode.commands.registerCommand('claudeLens.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('claudeLens.reopenRecent', () => reopenRecent(context)),
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
    return (await scan.sessionMeta(scan.resolveSession(projectSlug, file))).cwd;
  } catch { return null; }
}

async function copyResumeFromTree(el) {
  if (!el || el.kind !== 'sess') return;
  const cmd = resumeCommandString(el.s.id, await sessionCwd(el.p.slug, el.s.file));
  if (!cmd) return void vscode.window.showWarningMessage('claude-lens: unusable session id');
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.setStatusBarMessage('claude-lens: resume command copied', 3000);
}

/** Terminal tab label from a session title, falling back to a short id. */
function terminalName(title, sessionId) {
  const t = String(title || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) return t.length > 40 ? t.slice(0, 39) + '…' : t;
  return 'claude ' + String(sessionId).slice(0, 8);
}

/** Open a terminal (named for the session) in its cwd and run `claude --resume`. */
function resumeInTerminal(sessionId, cwd, title) {
  // The id and cwd come from transcript files; only a strict uuid-like
  // token may ever reach the terminal, and cwd must exist on disk.
  if (!/^[A-Za-z0-9-]{4,64}$/.test(sessionId)) {
    vscode.window.showWarningMessage('claude-lens: unusable session id');
    return false;
  }
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  const term = vscode.window.createTerminal({ name: terminalName(title, sessionId), cwd: dir });
  term.show();
  term.sendText(`claude --resume ${sessionId}`, true);
  return true;
}

async function resumeFromTree(el) {
  if (!el || el.kind !== 'sess') return;
  let title = null, cwd = null;
  try {
    const m = await scan.sessionMeta(scan.resolveSession(el.p.slug, el.s.file));
    title = m.title || m.firstPrompt; cwd = m.cwd;
  } catch { /* resume without cwd/name */ }
  resumeInTerminal(el.s.id, cwd, title);
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
    try { meta = await scan.sessionMeta(scan.resolveSession(p.slug, s.file)); } catch { /* uuid label */ }
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
  if (sel) recordRecent(context, sel.project, sel.file);
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
        if (!resumeInTerminal(String(msg.args.sessionId || ''), msg.args.cwd, msg.args.title)) {
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

/**
 * Per-MTok USD rates [prefix, input, output]; cache read bills 0.1× input,
 * cache write 1.25× input. Specific prefixes before generic. Rates as of
 * 2026-06 (Sonnet 5 at introductory pricing); unknown models are counted
 * in tokens but excluded from cost.
 */
const PRICING = [
  ['claude-fable-5', 10, 50], ['claude-mythos', 10, 50],
  ['claude-opus-4-5', 5, 25], ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-7', 5, 25], ['claude-opus-4-8', 5, 25],
  ['claude-opus', 15, 75],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
];

function usageCost(model, u) {
  const p = PRICING.find(([prefix]) => model.startsWith(prefix));
  if (!p) return null;
  return ((u.in || 0) * p[1] + (u.cr || 0) * p[1] * 0.1 + (u.cw || 0) * p[1] * 1.25 + (u.out || 0) * p[2]) / 1e6;
}

const totalTok = (u) => (u.in || 0) + (u.out || 0) + (u.cr || 0) + (u.cw || 0);
const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const fmtUsd = (n) => n >= 100 ? '$' + Math.round(n) : '$' + n.toFixed(2);

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
        resumeInTerminal(msg.sessionId, msg.cwd || (await sessionCwd(msg.project, msg.file)), msg.title);
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

  /**
   * Token usage across every session, scanned once per file and cached by
   * (size, mtime) in globalState so subsequent opens only read changed files.
   * Runs after the initial render and fills the Usage column via postMessage.
   */
  async computeUsage(all, fileProj) {
    const cache = this.context.globalState.get('lens.usageCache.v1', {});
    let dirty = false;
    let i = 0;
    const worker = async () => {
      for (;;) {
        const idx = i++;
        if (idx >= all.length) return;
        const { p, s } = all[idx];
        const fp = scan.resolveSession(p.slug, s.file);
        const key = fp;
        const hit = cache[key];
        if (hit && hit.size === s.size && hit.mtime === s.mtime) continue;
        try {
          cache[key] = { size: s.size, mtime: s.mtime, stats: await scan.usageStats(fp) };
          dirty = true;
        } catch { /* unreadable file — skip */ }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    if (dirty) await this.context.globalState.update('lens.usageCache.v1', cache);

    // aggregate: today, last 30 days, per model
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    const agg = { today: { tok: 0, usd: 0 }, month: { tok: 0, usd: 0 }, models: {}, projects: {}, unpriced: 0 };
    for (const { p, s } of all) {
      const name = p.name.split('/').pop();
      const proj = agg.projects[name] = agg.projects[name] || { tok: 0, usd: 0, sessions: 0 };
      proj.sessions++;
    }
    const live = new Set(all.map(({ p, s }) => scan.resolveSession(p.slug, s.file)));
    for (const [key, entry] of Object.entries(cache)) {
      if (!live.has(key)) continue;
      const { models, byDay } = entry.stats || {};
      const proj = agg.projects[fileProj.get(key)] || { tok: 0, usd: 0, sessions: 0 };
      for (const [m, u] of Object.entries(models || {})) {
        agg.models[m] = (agg.models[m] || 0) + totalTok(u);
        proj.tok += totalTok(u);
        const usd = usageCost(m, u);
        if (usd != null) proj.usd += usd;
      }
      for (const [day, u] of Object.entries(byDay || {})) {
        if (day < cutoff) continue;
        const tok = totalTok(u);
        // day-level model split isn't stored; price at the file's dominant model
        const top = Object.entries(entry.stats.models || {}).sort((a, b) => totalTok(b[1]) - totalTok(a[1]))[0];
        const usd = top ? usageCost(top[0], u) : null;
        agg.month.tok += tok;
        if (usd == null) agg.unpriced += tok; else agg.month.usd += usd;
        if (day === today) { agg.today.tok += tok; if (usd != null) agg.today.usd += usd; }
      }
    }
    return agg;
  }

  projectsHtml(agg) {
    const rows = Object.entries(agg.projects)
      .filter(([, v]) => v.sessions)
      .sort((a, b) => b[1].tok - a[1].tok);
    if (!rows.length) return '<h3>Projects</h3>';
    const max = Math.max(1, ...rows.map(([, v]) => v.tok));
    return '<h3>Projects</h3>' + rows.map(([name, v]) =>
      `<div class="prow"><div class="prow-top"><span class="pn" title="${esc(name)}">${esc(name)}</span>` +
      `<span class="pm">${v.sessions} session${v.sessions === 1 ? '' : 's'} · ${esc(fmtTok(v.tok))} tok` +
      `${v.usd ? ' · ' + esc(fmtUsd(v.usd)) : ''}</span></div>` +
      `<div class="pbar"><div style="width:${Math.max(2, Math.round(v.tok / max * 100))}%"></div></div></div>`
    ).join('');
  }

  usageHtml(agg) {
    const top = Object.entries(agg.models).sort((a, b) => b[1] - a[1])[0];
    let html = '<h3>Usage</h3>';
    html += `<div class="stat"><b>${esc(fmtUsd(agg.today.usd))}</b><span>today · ${esc(fmtTok(agg.today.tok))} tok</span></div>`;
    html += `<div class="stat"><b>${esc(fmtUsd(agg.month.usd))}</b><span>30 days · ${esc(fmtTok(agg.month.tok))} tok</span></div>`;
    if (top) html += `<div class="foot">top model: ${esc(top[0].replace(/^claude-/, ''))}</div>`;
    html += '<div class="foot">≈ at API rates, from local logs</div>';
    if (agg.unpriced) html += `<div class="foot">${esc(fmtTok(agg.unpriced))} tok unpriced</div>`;
    return html;
  }

  /** Meta for every session, concurrency-limited and cached across renders. */
  async allMetas(all) {
    this.metaCache = this.metaCache || new Map();
    const out = new Array(all.length);
    let i = 0;
    const worker = async () => {
      for (;;) {
        const idx = i++;
        if (idx >= all.length) return;
        const { p, s } = all[idx];
        const key = p.slug + '/' + s.file + ':' + s.mtime;
        if (!this.metaCache.has(key)) {
          this.metaCache.set(key,
            await scan.sessionMeta(scan.resolveSession(p.slug, s.file)).catch(() => ({})));
        }
        out[idx] = this.metaCache.get(key);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
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

    const metas = await this.allMetas(all);
    const sessions = all.map(({ p, s }, i) => {
      const m = metas[i] || {};
      return {
        project: p.slug, projName: p.name.split('/').pop(), file: s.file,
        sid: s.id, cwd: m.cwd || '', mtime: s.mtime, size: s.size,
        title: m.title || m.firstPrompt || s.id.slice(0, 8) + '…',
        prompt: (m.firstPrompt || '').slice(0, 300),
      };
    });

    const bars = days.map((d, i) => {
      const h = d.n ? Math.max(8, Math.round(d.n / max * 100)) : 4;
      const label = new Date(midnight.getTime() - (13 - i) * 86400e3)
        .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      return `<div class="bar${d.n ? '' : ' zero'}${i === 13 ? ' today' : ''}" style="height:${h}%"
        title="${esc(label)}: ${d.n} session${d.n === 1 ? '' : 's'} · ${fmtMB(d.bytes)}"></div>`;
    }).join('');

    const payload = JSON.stringify(sessions).replace(/</g, '\\u003c');

    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { height: 100%; }
      body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground);
             margin: 0; padding: 10px 14px; user-select: none; box-sizing: border-box; overflow: hidden; }
      #wrap { display: flex; flex-wrap: wrap; gap: 22px 26px; align-items: stretch;
              height: 100%; box-sizing: border-box; }
      #left { flex: 1 1 330px; min-width: 230px; display: flex; flex-direction: column; min-height: 0; }
      #toprow { display: flex; flex-wrap: wrap; gap: 16px 24px; flex: none; }
      #toprow > * { min-width: 0; }
      #projects { flex: 1 1 auto; min-height: 60px; overflow-y: auto; margin-top: 16px; }
      .prow { padding: 3px 0 5px; }
      .prow-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
      .prow .pn { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .prow .pm { color: var(--vscode-descriptionForeground); font-size: 11px; flex: none; }
      .pbar { height: 3px; border-radius: 2px; margin-top: 3px;
              background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
      .pbar > div { height: 100%; background: var(--vscode-charts-orange); opacity: 0.7; border-radius: 2px; }
      h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px;
           color: var(--vscode-descriptionForeground); font-weight: 600; }
      .stats { flex: 1 1 120px; display: flex; flex-direction: column; gap: 4px; min-width: 118px; }
      .stat b { font-size: 18px; font-weight: 600; }
      .stat span { color: var(--vscode-descriptionForeground); margin-left: 5px; }
      .foot { color: var(--vscode-descriptionForeground); font-size: 10.5px; margin-top: 3px; }
      .chartwrap { flex: 1 1 150px; min-width: 110px; max-width: 240px; }
      #chart { display: flex; align-items: flex-end; gap: 4px; height: 74px; overflow: hidden; }
      .bar { flex: 1; background: var(--vscode-charts-orange); opacity: 0.45; border-radius: 2px 2px 0 0; min-height: 3px; }
      .bar.today { opacity: 1; }
      .bar.zero { background: var(--vscode-descriptionForeground); opacity: 0.18; }
      #sessions { flex: 2 1 300px; min-width: 240px; display: flex; flex-direction: column; min-height: 0; }
      #shead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
      #shead h3 { margin: 0; flex: none; }
      #q { flex: 1; max-width: 340px; font: 12px var(--vscode-font-family);
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 3px 8px; outline: none; }
      #q:focus { border-color: var(--vscode-focusBorder); }
      #count { color: var(--vscode-descriptionForeground); font-size: 11px; flex: none; }
      #list { overflow-y: auto; flex: 1; min-height: 0; }
      .row { display: flex; align-items: center; gap: 8px; padding: 2.5px 6px; border-radius: 4px; cursor: pointer; }
      .row:hover { background: var(--vscode-list-hoverBackground); }
      .row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .row .t mark { background: none; color: var(--vscode-charts-orange); font-weight: 600; }
      .row .m { color: var(--vscode-descriptionForeground); flex: none; font-size: 11px; }
      .acts { flex: none; visibility: hidden; }
      .row:hover .acts { visibility: visible; }
      .acts button { background: none; border: none; color: var(--vscode-foreground);
                     cursor: pointer; font-size: 12px; padding: 0 4px; opacity: 0.75; }
      .acts button:hover { opacity: 1; }
      .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; }
      /* Narrow panel (e.g. Chat docked beside it): stack, let the page scroll. */
      @media (max-width: 720px) {
        html, body { height: auto; }
        body { overflow-y: auto; }
        #wrap { height: auto; flex-wrap: nowrap; flex-direction: column; gap: 18px; }
        #left, #sessions { flex: none; width: 100%; }
        #projects { flex: none; overflow: visible; }
        #list { flex: none; overflow: visible; }
        #q { max-width: none; }
      }
    </style></head><body>
    ${all.length ? `<div id="wrap">
      <div id="left">
        <div id="toprow">
          <div class="stats">
            <h3>Claude Code</h3>
            <div class="stat"><b>${today.n}</b><span>today · ${fmtMB(today.bytes)}</span></div>
            <div class="stat"><b>${week}</b><span>this week</span></div>
            <div class="stat"><b>${all.length}</b><span>total sessions</span></div>
          </div>
          <div class="stats" id="usage"><h3>Usage</h3><div class="foot">computing…</div></div>
          <div class="chartwrap"><h3>14 days</h3><div id="chart">${bars}</div></div>
        </div>
        <div id="projects"><h3>Projects</h3><div class="foot">computing…</div></div>
      </div>
      <div id="sessions">
        <div id="shead"><h3>Sessions</h3>
          <input id="q" type="text" placeholder="Search all sessions…" aria-label="Search sessions">
          <span id="count"></span></div>
        <div id="list"></div>
      </div>
    </div>` : '<div class="empty">No Claude Code sessions found. They appear here once you use the Claude Code CLI.</div>'}
    <script>
      const vs = acquireVsCodeApi();
      const SESSIONS = ${payload};
      window.addEventListener('message', (e) => {
        if (e.data && e.data.cmd === 'usage') {
          const el = document.getElementById('usage');
          if (el) el.innerHTML = e.data.html;
          const pr = document.getElementById('projects');
          if (pr && e.data.projects) pr.innerHTML = e.data.projects;
        }
      });
      const escH = (s) => String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const rel = (t) => {
        const d = Date.now() - t;
        if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + 'm';
        if (d < 86400e3) return Math.round(d / 3600e3) + 'h';
        return Math.round(d / 86400e3) + 'd';
      };
      const hi = (text, q) => {
        if (!q) return escH(text);
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) return escH(text);
        return escH(text.slice(0, i)) + '<mark>' + escH(text.slice(i, i + q.length)) + '</mark>' + escH(text.slice(i + q.length));
      };
      const list = document.getElementById('list');
      const count = document.getElementById('count');
      function show(q) {
        q = (q || '').trim().toLowerCase();
        const hits = q
          ? SESSIONS.filter((s) => s.title.toLowerCase().includes(q) || s.prompt.toLowerCase().includes(q)
              || s.projName.toLowerCase().includes(q))
          : SESSIONS;
        const shown = hits.slice(0, 60);
        count.textContent = q ? hits.length + ' match' + (hits.length === 1 ? '' : 'es') : 'recent';
        list.innerHTML = shown.map((s) => {
          const sub = q && !s.title.toLowerCase().includes(q) && s.prompt.toLowerCase().includes(q)
            ? '<div class="m" style="padding:0 6px 3px 6px">' + hi(s.prompt.slice(0, 120), q) + '</div>' : '';
          return '<div class="row" data-project="' + escH(s.project) + '" data-file="' + escH(s.file) +
            '" data-sid="' + escH(s.sid) + '" data-cwd="' + escH(s.cwd) + '" data-title="' + escH(s.title) + '">' +
            '<span class="t" title="' + escH(s.title) + '">' + hi(s.title, q) + '</span>' +
            '<span class="m">' + escH(s.projName) + ' · ' + rel(s.mtime) + '</span>' +
            '<span class="acts"><button data-act="copy" title="Copy resume command">⧉</button>' +
            '<button data-act="resume" title="Resume in terminal">▶</button></span></div>' + sub;
        }).join('') || '<div class="empty">No sessions match.</div>';
      }
      show('');
      document.getElementById('q').addEventListener('input', (e) => show(e.target.value));
      document.addEventListener('click', (e) => {
        const row = e.target.closest('.row');
        if (!row) return;
        const d = row.dataset;
        const act = e.target.closest('button')?.dataset.act;
        if (act === 'copy') vs.postMessage({ cmd: 'copy', sessionId: d.sid, cwd: d.cwd, project: d.project, file: d.file });
        else if (act === 'resume') vs.postMessage({ cmd: 'resume', sessionId: d.sid, cwd: d.cwd, project: d.project, file: d.file, title: d.title });
        else vs.postMessage({ cmd: 'open', project: d.project, file: d.file });
      });
    </script></body></html>`;

    if (all.length) {
      const fileProj = new Map(all.map(({ p, s }) =>
        [scan.resolveSession(p.slug, s.file), p.name.split('/').pop()]));
      this.computeUsage(all, fileProj).then((agg) => {
        if (this.view) {
          this.view.webview.postMessage({
            cmd: 'usage',
            html: this.usageHtml(agg),
            projects: this.projectsHtml(agg),
          });
        }
      }).catch(() => { /* usage stays at placeholder */ });
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
