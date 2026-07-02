'use strict';
/**
 * claude-lens test suite. Zero dependencies: `npm test`.
 * Uses a synthetic transcript fixture; never reads real sessions.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (name) => console.log('  ✓ ' + name);
function section(name) { console.log(name); }

/* ---------------------------------------------- browser-global stubs */

const dummy = new Proxy(function () {}, {
  get: (t, p) => (p === Symbol.toPrimitive ? () => '' : dummy),
  set: () => true,
  apply: () => dummy,
});
global.document = dummy;
global.window = dummy;
global.localStorage = {};
global.matchMedia = () => ({ matches: false });
global.location = { search: '' };
global.history = dummy;
global.CSS = { escape: (s) => s };
if (!global.navigator || !global.navigator.clipboard) {
  try { Object.defineProperty(global, 'navigator', { value: { clipboard: { writeText: async () => {} } } }); } catch { /* already usable */ }
}
const realFetch = global.fetch;
global.fetch = () => new Promise(() => {});

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
(0, eval)(script.replace("'use strict';", '')
  + ';globalThis.__lens = { md, parseJsonl, toolLabel, resultText, state, buildContextDigest, b64clean };');
const L = globalThis.__lens;

/* --------------------------------------------------- synthetic fixture */

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const base = { isSidechain: false, sessionId: SID, cwd: '/tmp/demo', gitBranch: 'main', timestamp: '2026-07-01T10:00:00Z' };
const fixture = [
  { type: 'ai-title', aiTitle: 'Fix the flaky test', sessionId: SID },
  { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'why is test_foo flaky?' } },
  { ...base, type: 'assistant', uuid: 'a1', requestId: 'r1', message: { model: 'claude-test-1', usage: { input_tokens: 10, output_tokens: 20 }, content: [
    { type: 'thinking', thinking: 'hmm, probably a race' },
    { type: 'text', text: 'Looking at the test:\n\n```py\nassert x == 1\n```\nIt races. See [docs](https://example.com).' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pytest -k foo', description: 'Run the flaky test' } },
  ] } },
  { ...base, type: 'user', uuid: 'u2', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: '1 failed' },
  ] } },
  { ...base, type: 'system', subtype: 'turn_duration', durationMs: 5000, messageCount: 4, uuid: 's1' },
].map((o) => JSON.stringify(o)).join('\n');

/* --------------------------------------------------------- unit tests */

section('markdown');
let out = L.md('before\n```js\ncode()\n```\nafter');
assert(out.includes('<pre><code>code()</code></pre>') && out.includes('<p>after</p>'), 'fences');
ok('code fences keep surrounding text');
out = L.md('# H\n- li\n\n| a |\n|---|\n| b |');
assert(out.includes('<h1>H</h1>') && out.includes('<li>li</li>') && out.includes('<td>b</td>'), 'blocks');
ok('headings, lists, tables');
assert(!L.md('<img src=x onerror=alert(1)>').includes('<img'), 'html escaped');
ok('raw HTML is escaped');
assert(!L.md('[x](javascript:alert(1))').includes('href'), 'js: url rejected');
ok('javascript: links are not linkified');

section('untrusted content');
assert(!/["'<>\s]/.test(L.b64clean('AA" onerror=\'x\' <svg>')), 'b64clean strips breakouts');
ok('image base64 sanitized');

section('transcript parsing');
const entries = L.parseJsonl(fixture + '\n{broken json');
assert(entries.length === 5, 'damaged line skipped');
ok('parses fixture, skips damaged lines');
assert(L.toolLabel('Bash', { description: 'Run it' }) === 'Run it', 'tool label');
assert(L.resultText([{ type: 'text', text: 'hi' }]) === 'hi', 'result text');
ok('tool labels and results');

section('context digest');
L.state.entries = entries;
L.state.current = { sessionId: SID, cwd: '/tmp/demo', gitBranch: 'main', title: 'Fix the flaky test', firstTs: Date.now() };
const digest = L.buildContextDigest();
assert(digest.startsWith('# Fix the flaky test'), 'title');
assert(digest.includes('claude --resume ' + SID), 'resume hint');
assert(digest.includes('## Prompt 1') && digest.includes('> tools: Bash(Run the flaky test)'), 'content');
ok('digest has title, resume hint, prompts, tools');

section('scan guards');
const scan = require(path.join(ROOT, 'lib', 'scan.js'));
assert(scan.resolveSession('..', 'x.jsonl') === null, 'project traversal');
assert(scan.resolveSession('proj', '../x.jsonl') === null, 'file traversal');
assert(scan.resolveSession('proj', 'x.txt') === null, 'extension check');
assert(scan.resolveSession('proj', 'x.jsonl') !== null, 'valid path accepted');
ok('path traversal rejected');

/* ------------------------------------------------------- server tests */

async function serverTests() {
  section('server');
  const port = 7911;
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'claude-lens.js'), '--no-open', '--port', String(port)], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { await realFetch(`http://127.0.0.1:${port}/`); up = true; } catch { /* retry */ }
    }
    assert(up, 'server started');

    let r = await realFetch(`http://127.0.0.1:${port}/`);
    assert(r.status === 200 && (await r.text()).includes('claude-lens'), 'serves UI');
    ok('serves the viewer');

    r = await realFetch(`http://127.0.0.1:${port}/api/projects`);
    assert(r.status === 200 && Array.isArray((await r.json()).projects), 'projects api');
    ok('projects API responds');

    r = await realFetch(`http://127.0.0.1:${port}/api/session?project=..&file=x.jsonl`);
    assert(r.status === 400, 'traversal rejected');
    ok('traversal request rejected');

    r = await realFetch(`http://127.0.0.1:${port}/%2e%2e/package.json`);
    assert(r.status === 404, 'encoded traversal rejected');
    ok('encoded static traversal rejected');

    // fetch won't override Host; use raw http for the rebinding check
    const status = await new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port, path: '/api/projects', headers: { Host: 'evil.example.com' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert(status === 403, 'dns rebinding blocked');
    ok('foreign Host header rejected (DNS rebinding)');
  } finally {
    child.kill();
  }
}

serverTests().then(() => {
  console.log('\nall tests passed');
}).catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
});
