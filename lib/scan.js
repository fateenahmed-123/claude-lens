'use strict';
/**
 * Shared session-scanning logic for claude-lens.
 * Used by both the CLI server (bin/claude-lens.js) and the VS Code
 * extension (vscode/extension.js). Zero dependencies.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const codex = require('./adapters/codex.js');

// Maps a session file basename to how it's read: { fullpath, agent }. Populated
// by listProjects so resolveSession can find non-Claude transcripts (Codex
// rollouts live in a nested YYYY/MM/DD tree, not root/slug/file).
const REGISTRY = new Map();

/** Whether Codex sessions are merged into the view (default on). */
let INCLUDE_CODEX = true;
function setIncludeCodex(on) { INCLUDE_CODEX = !!on; }

/** Codex session roots; null = the adapter's default (~/.codex/sessions). */
let CODEX_ROOTS = null;
function setCodexRoots(dirs) {
  const arr = (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).filter(Boolean).map(expandRoot);
  CODEX_ROOTS = arr.length ? arr : null;
}

/**
 * Sessions roots. One or more directories to scan; the default honors Claude
 * Code's own relocation mechanism (CLAUDE_CONFIG_DIR → $CLAUDE_CONFIG_DIR/projects,
 * else ~/.claude/projects). Multiple roots let sessions live outside ~/.claude —
 * backups, synced machines, a custom CLAUDE_CONFIG_DIR — all merged into one view.
 * Overridable via setRoots() / setRoot() (CLI --dir flags, VS Code setting).
 */
function defaultRoot() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

const expandRoot = (dir) => path.resolve(String(dir).replace(/^~(?=$|[\\/])/, os.homedir()));

/**
 * If `dir` is a Claude config dir (it contains a `projects/` subtree) rather
 * than a projects tree itself, scan that subtree. Users naturally point at the
 * config dir — e.g. a relocated CLAUDE_CONFIG_DIR like `~/.claude-ecc` — where
 * the real sessions live one level down in `projects/<slug>/*.jsonl`; pointing
 * at the config dir directly would otherwise surface only `history.jsonl`.
 */
function normalizeRoot(dir) {
  if (path.basename(dir) === 'projects') return dir;
  try {
    if (fs.statSync(path.join(dir, 'projects')).isDirectory()) return path.join(dir, 'projects');
  } catch { /* not a config dir */ }
  return dir;
}

let ROOTS = [defaultRoot()];

/** Set one or more session roots. Falsy/empty resets to the default. */
function setRoots(dirs) {
  const arr = (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).filter(Boolean).map(expandRoot).map(normalizeRoot);
  // de-dupe while preserving order
  ROOTS = arr.length ? arr.filter((d, i) => arr.indexOf(d) === i) : [defaultRoot()];
}
/** Back-compat single-root setter (CLI --dir with one value). */
function setRoot(dir) { setRoots(dir ? [dir] : null); }

const getRoots = () => ROOTS.slice();
const getRoot = () => ROOTS[0]; // primary root — for callers that only need one

const displayPath = (p) => {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
};
const getRootDisplay = () => ROOTS.map(displayPath).join('  ·  ');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Decode Claude Code's project-dir slug back into a real path. Slugs replace
 * "/", "." and "-" all with "-", so inversion is ambiguous; resolve it by
 * greedily matching the longest dash-joined segment that exists on disk.
 */
function decodeSlug(slug) {
  const parts = slug.replace(/^-/, '').split('-');
  let cur = path.sep, i = 0, ok = true;
  while (i < parts.length) {
    let found = -1, name = '', acc = '';
    for (let j = i; j < parts.length; j++) {
      acc = acc ? acc + '-' + parts[j] : parts[j];
      if (fs.existsSync(path.join(cur, acc))) { found = j; name = acc; }
      const dotted = acc.replace(/-/g, '.');
      if (fs.existsSync(path.join(cur, dotted))) { found = j; name = dotted; }
    }
    if (found === -1) { ok = false; break; }
    cur = path.join(cur, name);
    i = found + 1;
  }
  let p = ok ? cur : slug.replace(/-/g, '/');
  const home = os.homedir();
  if (p.startsWith(home)) p = '~' + p.slice(home.length);
  return p;
}

/**
 * Encode an absolute cwd into Claude Code's project-dir slug (/, ., _ → -), so
 * sessions from other agents (e.g. Codex) that share a working directory land
 * in the same project group as the Claude sessions for that repo.
 */
function encodeSlug(cwd) {
  return String(cwd || '').replace(/[/._]/g, '-');
}

/** Read up to `bytes` from the start or end of a file. */
async function readChunk(file, bytes, fromEnd) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromEnd ? size - len : 0);
    return { text: buf.toString('utf8'), partial: len < size };
  } finally {
    await fh.close();
  }
}

/** Whole JSONL lines from a chunk (drops the cut line at the open edge). */
function chunkLines(chunk, fromEnd) {
  const lines = chunk.text.split('\n');
  if (chunk.partial) {
    if (fromEnd) lines.shift();
    else lines.pop();
  }
  return lines.filter((l) => l.trim());
}

function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Last conversation timestamp from a transcript (epoch ms), or null.
 * Reads the tail first; scans the head only if the tail has no timestamps
 * (tiny sessions). Used instead of file mtime for grouping — opening a
 * session in an editor updates mtime without new conversation activity.
 */
async function sessionLastActivity(file) {
  const tail = await readChunk(file, 16 * 1024, true);
  const tailLines = chunkLines(tail, true);
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const o = tryParse(tailLines[i]);
    if (o && o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) return t;
    }
  }
  let last = null;
  const head = await readChunk(file, 8 * 1024, false);
  for (const line of chunkLines(head, false)) {
    const o = tryParse(line);
    if (o && o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) last = t;
    }
  }
  return last;
}

/** Cheap per-session metadata: title + first prompt without a full read. */
async function sessionMeta(file, agent) {
  if ((agent || agentOf(path.basename(file))) === 'codex') return codexMeta(file);
  const meta = { title: null, firstPrompt: null, model: null, cwd: null };

  const head = await readChunk(file, 256 * 1024, false);
  for (const line of chunkLines(head, false)) {
    const o = tryParse(line);
    if (!o) continue;
    if (!meta.cwd && o.cwd) meta.cwd = o.cwd;
    if (o.type === 'summary' && o.summary && !meta.title) meta.title = o.summary;
    if (o.type === 'user' && !o.isMeta && !o.isSidechain && !meta.firstPrompt) {
      const c = o.message && o.message.content;
      let text = null;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((b) => b.type === 'text');
        if (t) text = t.text;
      }
      if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) {
        meta.firstPrompt = text.slice(0, 200);
      }
    }
    if (meta.firstPrompt && meta.title) break;
  }

  const tail = await readChunk(file, 256 * 1024, true);
  const tailLines = chunkLines(tail, true);
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!meta.title && line.includes('"ai-title"')) {
      const o = tryParse(line);
      if (o && o.aiTitle) meta.title = o.aiTitle;
    }
    if (!meta.model && line.includes('"model"')) {
      const o = tryParse(line);
      const m = o && o.message && o.message.model;
      if (m && m !== '<synthetic>') meta.model = m;
    }
    if (meta.title && meta.model) break;
  }
  return meta;
}

/** Per-session metadata for a Codex rollout (no AI title; first human prompt). */
async function codexMeta(file) {
  const meta = { title: null, firstPrompt: null, model: null, cwd: null };
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return meta; }
  const n = codex.normalize(text);
  meta.cwd = n.cwd;
  meta.model = n.model;
  for (const e of n.entries) {
    if (e.type === 'user' && !e.isMeta && typeof e.message.content === 'string') {
      const t = e.message.content.trim();
      if (t && !t.startsWith('<')) { meta.firstPrompt = t.slice(0, 200); break; }
    }
  }
  return meta;
}

async function listProjects() {
  // slug -> { slug, name, byFile } merged across all roots; a session file
  // (globally-unique uuid) seen in two roots is de-duped, newest activity wins.
  const raw = [];
  REGISTRY.clear();

  for (const root of ROOTS) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }

    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      // Claude Code's command-history log lives at the config-dir root and is
      // not a session transcript — skip it so it doesn't show as a session.
      if (f.name === 'history.jsonl') continue;
      try {
        const fp = path.join(root, f.name);
        const st = await fsp.stat(fp);
        if (st.size > 0) {
          raw.push({
            slug: '.', name: '(loose files)',
            id: f.name.replace(/\.jsonl$/, ''), file: f.name, size: st.size,
            mtime: st.mtimeMs, fp,
          });
        }
      } catch { /* unreadable */ }
    }

    for (const d of entries.filter((e) => e.isDirectory())) {
      const pdir = path.join(root, d.name);
      let files = [];
      try { files = await fsp.readdir(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        let st;
        try { st = await fsp.stat(fp); } catch { continue; }
        if (st.size === 0) continue;
        raw.push({
          slug: d.name, name: decodeSlug(d.name),
          id: f.replace(/\.jsonl$/, ''), file: f, size: st.size,
          mtime: st.mtimeMs, fp,
        });
      }
    }
  }

  // Other agents (Codex today): grouped into the same project slug when they
  // share a cwd, so a repo shows Claude and Codex sessions side by side.
  if (INCLUDE_CODEX) {
    try {
      for (const s of await codex.listSessions(CODEX_ROOTS)) {
        const slug = s.cwd ? encodeSlug(s.cwd) : '.';
        raw.push({
          slug, name: s.cwd ? decodeSlug(slug) : '(codex)',
          id: s.id, file: s.file, size: s.size, mtime: s.mtime,
          fp: s.fullpath, agent: 'codex',
        });
      }
    } catch { /* codex not present */ }
  }

  let i = 0;
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= raw.length) return;
      const s = raw[idx];
      try {
        const last = await sessionLastActivity(s.fp);
        s.at = last != null ? last : s.mtime;
      } catch {
        s.at = s.mtime;
      }
      REGISTRY.set(s.file, { fullpath: s.fp, agent: s.agent || 'claude' });
      delete s.fp;
    }
  });
  await Promise.all(workers);

  const bySlug = new Map();
  for (const s of raw) {
    let p = bySlug.get(s.slug);
    if (!p) { p = { slug: s.slug, name: s.name, byFile: new Map() }; bySlug.set(s.slug, p); }
    const prev = p.byFile.get(s.file);
    if (!prev || s.at > prev.at) {
      p.byFile.set(s.file, {
        id: s.id, file: s.file, size: s.size, mtime: s.mtime, at: s.at, agent: s.agent || 'claude',
      });
    }
  }

  const out = [];
  for (const p of bySlug.values()) {
    const sessions = [...p.byFile.values()].sort((a, b) => b.at - a.at);
    if (sessions.length) out.push({ slug: p.slug, name: p.name, sessions });
  }
  out.sort((a, b) => b.sessions[0].at - a.sessions[0].at);
  return out;
}

/**
 * Full-file token usage scan. Reads every assistant entry carrying usage,
 * dedupes by requestId (one API response logs several entries sharing the
 * same usage), and aggregates per model and per day.
 */
async function usageStats(file, agent) {
  const raw = await fsp.readFile(file, 'utf8');
  const text = (agent || agentOf(path.basename(file))) === 'codex' ? codex.toJsonl(raw) : raw;
  const byReq = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"requestId"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.requestId || !o.message || !o.message.usage) continue;
    byReq.set(o.requestId, o); // last entry for a request carries final usage
  }
  const models = {}, byDay = {};
  const add = (t, u) => {
    t.in = (t.in || 0) + (u.input_tokens || 0);
    t.out = (t.out || 0) + (u.output_tokens || 0);
    t.cr = (t.cr || 0) + (u.cache_read_input_tokens || 0);
    t.cw = (t.cw || 0) + (u.cache_creation_input_tokens || 0);
  };
  for (const o of byReq.values()) {
    const m = o.message.model;
    if (!m || m === '<synthetic>') continue;
    const day = (o.timestamp || '').slice(0, 10);
    add(models[m] = models[m] || {}, o.message.usage);
    if (day) add(byDay[day] = byDay[day] || {}, o.message.usage);
  }
  return { models, byDay };
}

/**
 * Validate project/file names and return the absolute path, searching every
 * root. Prefers a root where the file actually exists; falls back to the first
 * root's join so well-formed-but-missing names still resolve to a stable path.
 */
function resolveSession(project, file) {
  if (!SAFE_NAME.test(project || '') || !SAFE_NAME.test(file || '') || !file.endsWith('.jsonl')) return null;
  if (project.includes('..') || file.includes('..')) return null;
  // Non-Claude transcripts (Codex) live outside the root/slug/file layout; the
  // registry (built by listProjects) knows where they are and how to read them.
  const reg = REGISTRY.get(file);
  if (reg && reg.fullpath && fs.existsSync(reg.fullpath)) return reg.fullpath;
  let fallback = null;
  for (const root of ROOTS) {
    const fp = path.normalize(project === '.' ? path.join(root, file) : path.join(root, project, file));
    if (!fp.startsWith(root + path.sep)) continue;
    if (fs.existsSync(fp)) return fp;
    if (!fallback) fallback = fp;
  }
  return fallback;
}

/** Which agent a resolved file belongs to ('claude' | 'codex'). */
function agentOf(file) {
  const reg = REGISTRY.get(file);
  return (reg && reg.agent) || 'claude';
}

/**
 * Session transcript as Claude-schema JSONL text, ready for the renderer and
 * the analysis helpers. Codex rollouts are normalized; Claude files pass
 * through unchanged. `agent` may be supplied to skip the registry lookup.
 */
async function sessionText(file, agent) {
  const raw = await fsp.readFile(file, 'utf8');
  let a = agent;
  if (!a) { const reg = REGISTRY.get(path.basename(file)); a = reg ? reg.agent : sniffAgent(raw); }
  return a === 'codex' ? codex.toJsonl(raw) : raw;
}

/** Guess the agent from a transcript's head when it isn't otherwise known. */
function sniffAgent(raw) {
  return /"type"\s*:\s*"session_meta"|"payload"\s*:\s*\{/.test(raw.slice(0, 2000)) ? 'codex' : 'claude';
}

module.exports = {
  decodeSlug, encodeSlug, sessionMeta, sessionLastActivity, listProjects, resolveSession,
  agentOf, sessionText, setRoot, setRoots, getRoot, getRoots, getRootDisplay, usageStats,
  setIncludeCodex, setCodexRoots,
};
