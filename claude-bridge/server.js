// Tiny bridge: accepts a Messages-API-style request from n8n, runs Claude Code
// headless (logged in with your Pro plan) and returns a Messages-API-style reply.
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const TIMEOUT_MS = 5 * 60 * 1000;

// Run one request at a time so parallel executions don't burn through limits at once
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

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
    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--model', model || DEFAULT_MODEL];
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
        if (res.is_error) return reject(new Error(res.result || 'Claude Code returned an error'));
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
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/v1/messages') return send(404, { error: 'not found' });

  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return send(400, { error: 'invalid JSON' }); }

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
        const limited = /limit|rate|quota/i.test(e.message);
        send(limited ? 429 : 502, { error: e.message });
      });
  });
}).listen(PORT, () => console.log(`claude-bridge listening on :${PORT}`));