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

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
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
  const out = [];
  let dirs = [];
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const pdir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = await fsp.readdir(pdir); } catch { continue; }
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let st;
      try { st = await fsp.stat(path.join(pdir, f)); } catch { continue; }
      if (st.size === 0) continue;
      sessions.push({ id: f.replace(/\.jsonl$/, ''), file: f, size: st.size, mtime: st.mtimeMs });
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtime - a.mtime);
    out.push({ slug: d.name, name: decodeSlug(d.name), sessions });
  }
  out.sort((a, b) => b.sessions[0].mtime - a.sessions[0].mtime);
  return out;
}

/** Validate project/file names and return an absolute path inside PROJECTS_DIR. */
function resolveSession(project, file) {
  if (!SAFE_NAME.test(project || '') || !SAFE_NAME.test(file || '') || !file.endsWith('.jsonl')) return null;
  const fp = path.join(PROJECTS_DIR, project, file);
  if (!fp.startsWith(PROJECTS_DIR + path.sep)) return null;
  return fp;
}

module.exports = { PROJECTS_DIR, decodeSlug, sessionMeta, listProjects, resolveSession };
