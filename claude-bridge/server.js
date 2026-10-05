// Tiny bridge: accepts a Messages-API-style request from n8n, runs Claude Code
// headless (logged in with your Pro plan) and returns a Messages-API-style reply.
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const TIMEOUT_MS = 5 * 60 * 1000;
const PROMPTS_FILE = process.env.PROMPTS_FILE || '/prompts/prompts.js'; // ./prompts mounted by docker-compose

// Run one request at a time so parallel executions don't burn through limits at once
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

// Job locks (one per bot, ?key=claude / gemini / local): n8n takes one before reading Telegram and
// releases it after both PDFs are sent, so each bot handles one offer at a time.
// A lock expires on its own if a run crashes midway.
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS) || 30 * 60 * 1000;
const locks = new Map(); // key -> expiry timestamp

// Return clean, valid JSON text or throw
function cleanJson(text) {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('no JSON object found');
  return JSON.stringify(JSON.parse(t.slice(s, e + 1)));
}

// Ask Claude, validate JSON, and ask it to repair its own output if invalid (up to 2 times)
async function generateJson({ system, prompt, model }) {
  let text = await runClaude({ system, prompt, model });
  for (let attempt = 0; ; attempt++) {
    try { return cleanJson(text); }
    catch (e) {
      if (attempt >= 2) throw new Error('Claude returned invalid JSON after 2 repairs: ' + e.message);
      console.log(`invalid JSON (${e.message}), asking for repair #${attempt + 1}`);
      text = await runClaude({
        system,
        model,
        prompt:
          `The following was supposed to be ONE valid JSON object but failed to parse (${e.message}).\n` +
          `Fix it: keep all content, correct the syntax (quotes, commas, braces), remove anything outside the object.\n` +
          `Return ONLY the corrected JSON object.\n\n${text}`
      });
    }
  }
}

function runClaude({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    // --tools "": text only. With tools on, the model sometimes tries one and hits --max-turns 1 (an error with no text)
    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--no-session-persistence',
      '--model', model || DEFAULT_MODEL];
    if (system) args.push('--system-prompt', system);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // make sure the subscription is used, not API billing

    const proc = spawn('claude', args, { env });
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Claude Code timed out')); }, TIMEOUT_MS);

    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (err += d));
    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(`Claude Code returned an error (${res.subtype || 'unknown'}): ${res.result || ''}`.trim()));
        resolve(res.result);
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
    });
    proc.stdin.end(prompt);
  });
}

http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://bridge');
  const key = url.searchParams.get('key') || 'default';
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/lock') {
    if (Date.now() < (locks.get(key) || 0)) return send(200, { acquired: false });
    locks.set(key, Date.now() + LOCK_TTL_MS);
    return send(200, { acquired: true });
  }
  if (req.method === 'POST' && url.pathname === '/unlock') {
    locks.delete(key);
    return send(200, { released: true });
  }
  if (req.method !== 'POST' || !['/v1/messages', '/prompts'].includes(url.pathname)) return send(404, { error: 'not found' });

  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return send(400, { error: 'invalid JSON' }); }

    // Shared prompts for all bots, re-read on every call so edits apply without a restart
    if (url.pathname === '/prompts') {
      try {
        delete require.cache[require.resolve(PROMPTS_FILE)];
        const { buildPrompts } = require(PROMPTS_FILE);
        return send(200, { chatId: data.chatId, jobOffer: data.jobOffer, ...buildPrompts(data) });
      } catch (e) {
        console.error('prompts failed:', e.message);
        return send(500, { error: 'prompts/prompts.js: ' + e.message });
      }
    }

    const prompt = (data.messages || [])
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content
        : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'))
      .join('\n\n');
    if (!prompt) return send(400, { error: 'no user message' });

    const args = { system: data.system, prompt, model: data.model };
    const job = data.expect_json === false ? () => runClaude(args) : () => generateJson(args);
    serial(job)
      .then(text => send(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn' }))
      .catch(e => {
        console.error('request failed:', e.message);
        const limited = /limit|rate|quota/i.test(e.message);
        send(limited ? 429 : 502, { error: e.message });
      });
  });
}).listen(PORT, () => console.log(`claude-bridge listening on :${PORT}`));