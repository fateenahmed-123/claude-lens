#!/usr/bin/env node
/**
 * claude-lens — local viewer for Claude Code CLI session transcripts.
 *
 * Zero dependencies. Serves public/index.html plus a small JSON API over
 * the JSONL session files Claude Code writes under ~/.claude/projects/.
 *
 * Usage:
 *   claude-lens                     # browse every project on this machine
 *   claude-lens --port 7777
 *   claude-lens path/to/session.jsonl   # open one transcript directly
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const scan = require('../lib/scan.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------- args

const args = process.argv.slice(2);
let port = 7777;
let singleFile = null;
let noOpen = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') port = Number(args[++i]) || port;
  else if (a === '--dir' || a === '-d') scan.setRoot(args[++i]);
  else if (a === '--no-open') noOpen = true;
  else if (a === '--help' || a === '-h') {
    console.log(`claude-lens [file.jsonl] [--dir path] [--port N] [--no-open]

Visualize Claude Code CLI sessions. Reads ~/.claude/projects/ by default,
or $CLAUDE_CONFIG_DIR/projects when that variable is set.
  --dir path   read sessions from a different folder (a projects tree
               or any folder containing .jsonl transcripts)
Pass a .jsonl path to open a single transcript directly.`);
    process.exit(0);
  } else if (a.endsWith('.jsonl')) singleFile = path.resolve(a);
}

// ------------------------------------------------------------- server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Transcripts are sensitive. The server binds to loopback, and this Host
  // check blocks DNS-rebinding tricks that would let a web page reach it.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''))) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/api/projects') {
      const projects = await scan.listProjects();
      return json(res, 200, { root: scan.getRootDisplay(), single: !!singleFile, projects });
    }

    if (url.pathname === '/api/meta') {
      const file = scan.resolveSession(url.searchParams.get('project'), url.searchParams.get('file'));
      if (!file) return json(res, 400, { error: 'bad path' });
      return json(res, 200, await scan.sessionMeta(file));
    }

    if (url.pathname === '/api/session') {
      const file = scan.resolveSession(url.searchParams.get('project'), url.searchParams.get('file'));
      if (!file) return json(res, 400, { error: 'bad path' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      fs.createReadStream(file).on('error', () => res.end()).pipe(res);
      return;
    }

    if (url.pathname === '/api/single') {
      if (!singleFile) return json(res, 404, { error: 'no file given' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      fs.createReadStream(singleFile).on('error', () => res.end()).pipe(res);
      return;
    }

    // static
    let rel = 'index.html';
    if (url.pathname !== '/') {
      try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { rel = ''; }
    }
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) { res.writeHead(404); return res.end(); }
    const fp = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
    try {
      let body = await fsp.readFile(fp);
      if (fp.endsWith('index.html')) {
        body = Buffer.from(body.toString('utf8')
          .replace('__LENS_VERSION__', 'v' + require('../package.json').version));
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (err) {
    json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = `http://localhost:${port}${singleFile ? '/?single=1' : ''}`;
  console.log(`claude-lens ready → ${addr}`);
  if (!noOpen) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${cmd} ${addr}`, () => {});
  }
});
