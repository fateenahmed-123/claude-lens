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

let ROOTS = [defaultRoot()];

/** Set one or more session roots. Falsy/empty resets to the default. */
function setRoots(dirs) {
  const arr = (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).filter(Boolean).map(expandRoot);
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

/** Cheap per-session metadata: title + first prompt without a full read. */
async function sessionMeta(file) {
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

async function listProjects() {
  // slug -> { slug, name, byFile } merged across all roots; a session file
  // (globally-unique uuid) seen in two roots is de-duped, newest mtime wins.
  const bySlug = new Map();
  const push = (slug, name, s) => {
    let p = bySlug.get(slug);
    if (!p) { p = { slug, name, byFile: new Map() }; bySlug.set(slug, p); }
    const prev = p.byFile.get(s.file);
    if (!prev || s.mtime > prev.mtime) p.byFile.set(s.file, s);
  };

  for (const root of ROOTS) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }

    // Loose .jsonl directly in a root (a copied/backup folder rather than a
    // real projects tree) become one pseudo-project keyed ".".
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try {
        const st = await fsp.stat(path.join(root, f.name));
        if (st.size > 0) push('.', '(loose files)', { id: f.name.replace(/\.jsonl$/, ''), file: f.name, size: st.size, mtime: st.mtimeMs });
      } catch { /* unreadable */ }
    }

    for (const d of entries.filter((e) => e.isDirectory())) {
      const pdir = path.join(root, d.name);
      let files = [];
      try { files = await fsp.readdir(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        let st;
        try { st = await fsp.stat(path.join(pdir, f)); } catch { continue; }
        if (st.size === 0) continue;
        push(d.name, decodeSlug(d.name), { id: f.replace(/\.jsonl$/, ''), file: f, size: st.size, mtime: st.mtimeMs });
      }
    }
  }

  const out = [];
  for (const p of bySlug.values()) {
    const sessions = [...p.byFile.values()].sort((a, b) => b.mtime - a.mtime);
    if (sessions.length) out.push({ slug: p.slug, name: p.name, sessions });
  }
  out.sort((a, b) => b.sessions[0].mtime - a.sessions[0].mtime);
  return out;
}

/**
 * Full-file token usage scan. Reads every assistant entry carrying usage,
 * dedupes by requestId (one API response logs several entries sharing the
 * same usage), and aggregates per model and per day.
 */
async function usageStats(file) {
  const text = await fsp.readFile(file, 'utf8');
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
  let fallback = null;
  for (const root of ROOTS) {
    const fp = path.normalize(project === '.' ? path.join(root, file) : path.join(root, project, file));
    if (!fp.startsWith(root + path.sep)) continue;
    if (fs.existsSync(fp)) return fp;
    if (!fallback) fallback = fp;
  }
  return fallback;
}

module.exports = { decodeSlug, sessionMeta, listProjects, resolveSession, setRoot, setRoots, getRoot, getRoots, getRootDisplay, usageStats };
