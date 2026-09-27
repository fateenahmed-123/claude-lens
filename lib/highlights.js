'use strict';
/**
 * "Highlights" — a standup-ready summary of what happened across Claude Code
 * (and compatible) sessions in a time window (yesterday by default).
 *
 * Zero dependencies, fully offline: it reads the same JSONL transcripts the
 * viewer already scans and derives, per project, what was asked, what files
 * changed, which commands/tests ran, and what got committed. The heuristic
 * report always works; callers may additionally hand `aiPrompt` to a local
 * `claude` CLI to polish the wording (see the VS Code extension).
 */

const fs = require('fs');
const fsp = fs.promises;
const scan = require('./scan');

/** Resolve a named window to an epoch-ms [from, to) range. */
function windowRange(name, now) {
  const t = now == null ? Date.now() : now;
  const midnight = new Date(t); midnight.setHours(0, 0, 0, 0);
  const day0 = midnight.getTime();
  const DAY = 86400e3;
  switch (name) {
    case 'today': return { key: 'today', label: 'Today', from: day0, to: t };
    case '7d': case 'week':
      return { key: '7d', label: 'Last 7 days', from: day0 - 6 * DAY, to: t };
    case 'yesterday': default:
      return { key: 'yesterday', label: 'Yesterday', from: day0 - DAY, to: day0 };
  }
}

/** A user turn that carries real human text/image content (not tool plumbing). */
function isHumanPrompt(o) {
  if (o.isMeta || o.isSidechain) return false;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b.type === 'text' || b.type === 'image');
}

/** Plain, trimmed text of a human prompt, or '' if it's noise to skip. */
function promptText(o) {
  const c = o.message.content;
  let text = typeof c === 'string'
    ? c
    : (c || []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
  text = (text || '').trim();
  if (!text) return '';
  if (/^\[Request interrupted/.test(text)) return '';
  if (text.includes('<local-command-stdout>')) return '';
  if (text.startsWith('Caveat:')) return '';
  const cm = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cm) return 'ran ' + cm[1].trim();
  if (text.startsWith('<')) return ''; // other injected system blocks
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort commit title from a `git commit` command. Handles a plain
 * `-m "msg"`, and the heredoc form `-m "$(cat <<'EOF' \n <title> \n ... )"`
 * that Claude Code uses for multi-line messages — where the real title is the
 * first content line, not the shell wrapper.
 */
function commitMessage(cmd) {
  const here = cmd.match(/-m\s*["']?\$\(\s*cat\s*<<[-']*\s*['"]?\w+['"]?\s*\n([^\n]+)/);
  if (here) return here[1].trim();
  const dollar = cmd.match(/-m\s*\$'((?:[^'\\]|\\.)*)'/);
  if (dollar) return dollar[1].split('\\n')[0].replace(/\\(.)/g, '$1').trim();
  const quoted = cmd.match(/-m\s*(["'])([\s\S]*?)\1/);
  if (quoted && !quoted[2].startsWith('$(')) return quoted[2].split('\n')[0].trim();
  return null; // couldn't parse a clean title; count happens via commands
}

/** Record one tool_use into the per-session activity accumulator. */
function classifyTool(name, input, act) {
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const f = input.file_path || input.notebook_path;
    if (f) act.edits.set(f, (act.edits.get(f) || 0) + 1);
    if (name === 'Write' && f && !act.edits.has(f + '\0w')) act.created.add(f);
    return;
  }
  if (name === 'Bash' && input.command) {
    const cmd = String(input.command);
    act.commands.push(input.description || cmd.split('\n')[0].slice(0, 80));
    if (/\bgit\s+commit\b/.test(cmd)) {
      const msg = commitMessage(cmd);
      if (msg) act.commits.push(msg);
    }
    // A real test run invokes a test runner — not merely a command mentioning
    // "test" (build steps, file names, and descriptions trip that up).
    if (/(^|[|&;]\s*|\bnpx\s+)(pytest|jest|vitest|mocha|rspec|phpunit|tox|ava|karma)\b/.test(cmd)
      || /\b(go\s+test|cargo\s+test|npm\s+(run\s+)?test|npm\s+t\b|yarn\s+test|pnpm\s+test|python\s+-m\s+pytest|ctest|gradle\s+test|mvn\s+test|dotnet\s+test)\b/.test(cmd)) {
      act.tests.push(cmd.split('\n')[0].slice(0, 60));
    }
  }
}

/** Scan a single transcript into a structured activity record. */
async function sessionActivity(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return null; }
  const act = {
    title: null, firstTs: null, lastTs: null, cwd: null, gitBranch: null,
    models: new Set(), prompts: [], edits: new Map(), created: new Set(),
    commands: [], commits: [], tests: [], activeMs: 0, tokensIn: 0, tokensOut: 0,
  };
  const byReq = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle && !act.title) act.title = o.aiTitle;
    if (o.type === 'summary' && o.summary && !act.title) act.title = o.summary;
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) { if (act.firstTs == null) act.firstTs = t; act.lastTs = t; }
    }
    if (o.cwd && !act.cwd) act.cwd = o.cwd;
    if (o.gitBranch && !act.gitBranch) act.gitBranch = o.gitBranch;
    if (o.type === 'system' && o.subtype === 'turn_duration') act.activeMs += o.durationMs || 0;
    if (o.isSidechain || o.isMeta) continue;
    if (o.type === 'user' && isHumanPrompt(o)) {
      const t = promptText(o);
      if (t) act.prompts.push(t);
    } else if (o.type === 'assistant' && o.message) {
      if (o.requestId && o.message.usage) byReq.set(o.requestId, o.message.usage);
      const m = o.message.model;
      if (m && m !== '<synthetic>') act.models.add(m);
      for (const b of o.message.content || []) {
        if (b.type === 'tool_use') classifyTool(b.name, b.input || {}, act);
      }
    }
  }
  for (const u of byReq.values()) {
    act.tokensIn += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    act.tokensOut += u.output_tokens || 0;
  }
  return act;
}

const shortModel = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const baseName = (p) => String(p).split('/').pop();

/** Fold a project's in-window sessions into one summary with standup bullets. */
function summarizeProject(project, items) {
  const files = new Map(); // path -> edit count
  const commands = [], commits = [], tests = [], prompts = [], models = new Set();
  let activeMs = 0, tokensIn = 0, tokensOut = 0, first = Infinity, last = 0;
  for (const { act } of items) {
    for (const [f, n] of act.edits) files.set(f, (files.get(f) || 0) + n);
    commands.push(...act.commands);
    commits.push(...act.commits.filter((c) => c && c !== '(commit)'));
    tests.push(...act.tests);
    prompts.push(...act.prompts);
    act.models.forEach((m) => models.add(m));
    activeMs += act.activeMs;
    tokensIn += act.tokensIn; tokensOut += act.tokensOut;
    if (act.firstTs != null) first = Math.min(first, act.firstTs);
    if (act.lastTs != null) last = Math.max(last, act.lastTs);
  }

  // Bullets: completed commits are the strongest signal of finished work;
  // supplement with the most substantive prompts (the stated intent).
  const bullets = [];
  const seen = new Set();
  const add = (b) => { const k = b.toLowerCase(); if (b && !seen.has(k)) { seen.add(k); bullets.push(b); } };
  for (const c of commits) add(c.charAt(0).toUpperCase() + c.slice(1));
  const wantPrompts = Math.max(0, 4 - bullets.length);
  prompts
    .filter((p) => p.length > 12 && !/^(ok|thanks|yes|no|continue|go ahead)\b/i.test(p))
    .slice(0, wantPrompts)
    .forEach((p) => add(p.length > 160 ? p.slice(0, 157).trimEnd() + '…' : p));

  return {
    slug: project.slug,
    name: baseName(project.name) || project.name,
    fullName: project.name,
    sessions: items.length,
    activeMs,
    tokensIn, tokensOut,
    first, last,
    models: [...models].map(shortModel),
    bullets,
    files: [...files.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => ({ file: baseName(f), path: f, edits: n })),
    commits,
    tests: [...new Set(tests)],
    commands: commands.length,
  };
}

function aggregate(groups) {
  const t = { sessions: 0, projects: groups.length, activeMs: 0, files: 0, commits: 0, tests: 0, tokensIn: 0, tokensOut: 0 };
  for (const g of groups) {
    t.sessions += g.sessions; t.activeMs += g.activeMs; t.files += g.files.length;
    t.commits += g.commits.length; t.tests += g.tests.length;
    t.tokensIn += g.tokensIn; t.tokensOut += g.tokensOut;
  }
  return t;
}

const fmtDur = (ms) => {
  if (!ms) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
};

/** Standup-ready markdown. */
function toMarkdown(report) {
  const { window: w, totals, projects } = report;
  const lines = [`# ${w.label}'s Highlights`];
  if (!projects.length) {
    lines.push('', `*No Claude Code activity ${w.label.toLowerCase()}.*`);
    return lines.join('\n');
  }
  lines.push('', [
    `${totals.sessions} session${totals.sessions === 1 ? '' : 's'}`,
    `${totals.projects} project${totals.projects === 1 ? '' : 's'}`,
    `~${fmtDur(totals.activeMs)} active`,
    `${totals.files} file${totals.files === 1 ? '' : 's'} changed`,
    ...(totals.commits ? [`${totals.commits} commit${totals.commits === 1 ? '' : 's'}`] : []),
  ].join(' · '));
  for (const g of projects) {
    lines.push('', `## ${g.name}  *(${g.sessions} session${g.sessions === 1 ? '' : 's'} · ${fmtDur(g.activeMs)})*`);
    for (const b of g.bullets) lines.push(`- ${b}`);
    const meta = [];
    if (g.files.length) meta.push(`Files: ${g.files.slice(0, 6).map((f) => f.file + (f.edits > 1 ? ` ×${f.edits}` : '')).join(', ')}`);
    if (g.tests.length) meta.push(`Tests run: ${g.tests.length}`);
    if (meta.length) lines.push('', `*${meta.join(' · ')}*`);
  }
  return lines.join('\n');
}

/** Slack-friendly variant (mrkdwn: *bold*, • bullets). */
function toSlack(report) {
  const { window: w, totals, projects } = report;
  if (!projects.length) return `*${w.label}'s Highlights* — no Claude Code activity.`;
  const out = [`*${w.label}'s Highlights*  ·  ${totals.sessions} sessions · ${totals.projects} projects · ~${fmtDur(totals.activeMs)} active`];
  for (const g of projects) {
    out.push('', `*${g.name}*`);
    for (const b of g.bullets) out.push(`• ${b}`);
  }
  return out.join('\n');
}

/** A prompt for a local `claude` CLI to polish the heuristic report into prose. */
function toAiPrompt(report) {
  return [
    'You are writing a concise daily standup update from a developer\'s AI-assisted',
    'coding activity. Rewrite the notes below as crisp, first-person standup bullets',
    'grouped by project. Keep it factual — do not invent work that is not listed.',
    'Prefer past tense ("Fixed…", "Added…"). Output markdown only.',
    '',
    '--- raw activity ---',
    report.markdown,
  ].join('\n');
}

/**
 * Build the highlights report for a window. Reads in-window sessions across all
 * configured roots, concurrency-limited. Returns a structured report plus
 * `markdown`, `slack`, and `aiPrompt` renderings.
 */
async function buildHighlights(opts) {
  const o = opts || {};
  const range = windowRange(o.window || 'yesterday', o.now);
  const projects = await scan.listProjects();

  // Flatten in-window sessions, keep their project, read transcripts with a pool.
  const jobs = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      if (s.at >= range.from && s.at < range.to) jobs.push({ p, s });
    }
  }
  const results = new Array(jobs.length);
  let i = 0;
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= jobs.length) return;
      const { p, s } = jobs[idx];
      const file = scan.resolveSession(p.slug, s.file);
      results[idx] = file ? { p, s, act: await sessionActivity(file) } : null;
    }
  });
  await Promise.all(workers);

  const byProject = new Map();
  for (const r of results) {
    if (!r || !r.act) continue;
    let g = byProject.get(r.p.slug);
    if (!g) { g = { project: r.p, items: [] }; byProject.set(r.p.slug, g); }
    g.items.push({ session: r.s, act: r.act });
  }

  const groups = [...byProject.values()]
    .map((g) => summarizeProject(g.project, g.items))
    .sort((a, b) => b.activeMs - a.activeMs || b.sessions - a.sessions);

  const report = { generatedAt: Date.now(), window: range, totals: aggregate(groups), projects: groups };
  report.markdown = toMarkdown(report);
  report.slack = toSlack(report);
  report.aiPrompt = toAiPrompt(report);
  return report;
}

module.exports = {
  buildHighlights, windowRange, sessionActivity, summarizeProject,
  toMarkdown, toSlack, toAiPrompt, fmtDur,
};
