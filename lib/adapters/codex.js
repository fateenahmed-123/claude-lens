'use strict';
/**
 * Codex adapter — maps OpenAI Codex CLI/Desktop session rollouts into the
 * common entry model the viewer already renders (the Claude Code schema).
 *
 * Codex stores one JSONL "rollout" per session under
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * Each line is {timestamp, type, payload}. We translate the lines we care
 * about — conversation messages, tool calls/results, reasoning, and token
 * usage — into Claude-style entries so metadata, usage, highlights, and the
 * transcript renderer all work unchanged. Zero dependencies, fully offline.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const AGENT = 'codex';
const LABEL = 'Codex';

function defaultRoot() {
  if (process.env.CODEX_HOME) return path.join(process.env.CODEX_HOME, 'sessions');
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** Codex session roots can be given explicitly; default is ~/.codex/sessions. */
function roots(extra) {
  const list = (Array.isArray(extra) ? extra : extra ? [extra] : []).filter(Boolean);
  return list.length ? list : [defaultRoot()];
}

/** Injected context turns (not something the human typed) — hidden like isMeta. */
function isInjected(text) {
  return /^\s*<(app-context|recommended_plugins|environment_context|user_instructions|user_info|editor_context)/.test(text);
}

/** Codex tool name → a label the shared renderer/heuristics understand. */
function mapToolName(name, isCustom) {
  if (!name) return isCustom ? 'exec' : 'tool';
  if (/^(shell|bash|exec|container\.exec|local_shell)$/i.test(name)) return 'Bash';
  if (/^(apply_patch|edit|str_replace|write_file|update_file)$/i.test(name)) return 'Edit';
  if (/^(read_file|view|cat)$/i.test(name)) return 'Read';
  return name;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return c.text || '';
    if (c.type === 'input_image' || c.type === 'image') return '[image]';
    return '';
  }).join('\n');
}

/**
 * Normalize a rollout's text into Claude-style entries plus session facts.
 * Returns { entries, cwd, sessionId, model, firstTs, lastTs }.
 */
function normalize(text) {
  const entries = [];
  let cwd = null, sessionId = null, model = null, firstTs = null, lastTs = null;
  let sawUsageRecord = false;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || null;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      cwd = p.cwd || cwd;
      sessionId = p.session_id || p.id || sessionId;
      continue;
    }
    if (o.type === 'turn_context') {
      if (p.model) model = p.model;
      cwd = p.cwd || cwd;
      continue;
    }
    if (o.type === 'token_usage_record' && p.usage) {
      sawUsageRecord = true;
      entries.push({
        type: 'assistant', timestamp: ts, requestId: p.response_id || p.turn_id,
        message: { model: model || 'codex', usage: codexUsage(p.usage) },
      });
      continue;
    }
    // Older rollouts carry usage in event_msg/token_count instead; use the
    // per-turn delta, and only when no structured usage records are present.
    if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage && !sawUsageRecord) {
      entries.push({
        type: 'assistant', timestamp: ts, requestId: 'tc-' + (p.info.last_token_usage.total_tokens || 0) + '-' + (ts || ''),
        message: { model: model || 'codex', usage: codexUsage(p.info.last_token_usage) },
      });
      continue;
    }
    if (o.type !== 'response_item') continue;

    const it = p;
    if (it.type === 'message') {
      const text2 = textOf(it.content).trim();
      if (!text2) continue;
      if (it.role === 'assistant') {
        entries.push({ type: 'assistant', timestamp: ts, message: { model: model || 'codex', content: [{ type: 'text', text: text2 }] } });
      } else {
        const meta = it.role !== 'user' || isInjected(text2);
        entries.push({ type: 'user', timestamp: ts, cwd, isMeta: meta, message: { role: 'user', content: text2 } });
      }
    } else if (it.type === 'reasoning') {
      const summary = Array.isArray(it.summary) && it.summary.length
        ? it.summary.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n').trim()
        : '';
      entries.push({ type: 'assistant', timestamp: ts, message: { model: model || 'codex', content: [{ type: 'thinking', thinking: summary || '[reasoning hidden by Codex]' }] } });
    } else if (it.type === 'function_call' || it.type === 'custom_tool_call') {
      const custom = it.type === 'custom_tool_call';
      let input;
      if (custom) input = { command: typeof it.input === 'string' ? it.input : JSON.stringify(it.input) };
      else { try { input = JSON.parse(it.arguments || '{}'); } catch { input = { arguments: it.arguments }; } }
      entries.push({ type: 'assistant', timestamp: ts, message: { model: model || 'codex', content: [{ type: 'tool_use', id: it.call_id, name: mapToolName(it.name, custom), input }] } });
    } else if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') {
      entries.push({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: it.call_id, content: textOf(it.output) }] } });
    }
  }
  return { entries, cwd, sessionId, model, firstTs, lastTs };
}

function codexUsage(u) {
  // Codex `input_tokens` is the TOTAL input (cached included); Claude's schema
  // counts `input_tokens` as the uncached portion with cache reads separate, so
  // subtract to keep token totals and cost estimates accurate.
  const cached = u.cached_input_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: u.cache_write_input_tokens || 0,
  };
}

/** Normalized entries as Claude-style JSONL (for the transcript endpoint). */
function toJsonl(text) {
  return normalize(text).entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Recursively collect rollout file paths under a root (YYYY/MM/DD tree). */
async function walk(dir, out) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await walk(fp, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(fp);
  }
}

/** Read the session_meta from a rollout head to learn its cwd + id. */
async function headInfo(fp) {
  let fh;
  try {
    fh = await fsp.open(fp, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    for (const line of text.split('\n')) {
      if (!line.includes('session_meta')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'session_meta') {
          const p = o.payload || {};
          return { cwd: p.cwd || null, id: p.session_id || p.id || null };
        }
      } catch { /* partial last line */ }
    }
  } catch { /* unreadable */ } finally { if (fh) await fh.close(); }
  return { cwd: null, id: null };
}

/**
 * List Codex sessions across roots as session descriptors. Reads a small head
 * of each file for cwd (grouping) and session id. `at` (last activity) is read
 * by the caller from the file tail, which works directly on rollout timestamps.
 */
async function listSessions(extra) {
  const files = [];
  for (const r of roots(extra)) await walk(r, files);
  const out = [];
  // Bounded concurrency so large histories don't open thousands of fds at once.
  let i = 0;
  const run = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= files.length) return;
      const fp = files[idx];
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      if (!st.size) continue;
      const info = await headInfo(fp);
      const base = path.basename(fp);
      const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      out[idx] = {
        agent: AGENT, fullpath: fp, file: base, size: st.size, mtime: st.mtimeMs,
        cwd: info.cwd, id: info.id || (m ? m[1] : base.replace(/\.jsonl$/, '')),
      };
    }
  };
  await Promise.all(Array.from({ length: 8 }, run));
  return out.filter(Boolean);
}

module.exports = { AGENT, LABEL, defaultRoot, roots, normalize, toJsonl, listSessions, mapToolName };
