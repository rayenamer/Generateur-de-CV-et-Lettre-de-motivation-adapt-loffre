# CV & Cover Letter Generator

Send a job offer to a Telegram bot → get back a CV and a cover letter tailored to it, as PDFs.

---

## What you get

For every job offer you send:

1. **"Je traite cette offre..."** — the bot confirms it got the offer
2. **CV (PDF)** — rewritten for the offer, built to match ATS keywords
3. **Cover letter (PDF)**
4. **ATS report** — keywords covered, and the list of things added beyond your real profile
   (read it before an interview: a recruiter can ask about any line of the CV)

If a step fails you get a **❌ Generation failed…** message instead. Just send the offer again.

---

## Three bots, three AI engines

| Bot | Engine | Cost | Speed | Workflow file |
|---|---|---|---|---|
| Claude bot | Claude (your Claude Pro plan, via Claude Code) | included in Pro | ~2 min per document | `cv-cover-letter-claude-pro.json` |
| Gemini bot | Google Gemini API | free tier | fast, but sometimes "high demand" | `cv-cover-letter-gemini.json` |
| Local bot | Small open-source model (Ollama, runs on your PC) | free, offline | slow on CPU (several minutes) | `cv-cover-letter-local.json` |

Each bot has its **own Telegram bot**. Run one, two or all three.

---

## How it works

```
Telegram ──► n8n ──► AI engine ──► xelatex-api ──► PDFs ──► Telegram
                     │
                     ├─ claude-bridge  (Claude Code, Pro plan)
                     ├─ Gemini API     (Google)
                     └─ ollama         (local model)
```

**The containers** (`docker-compose.yml`):

- **n8n** — runs the workflows (http://localhost:5678)
- **xelatex-api** — turns the JSON into PDFs (`main.py`)
- **claude-bridge** — lets n8n use Claude through your Pro login (`claude-bridge/server.js`)
  - it also serves the **shared prompts** (`prompts/`) and holds the **job locks** for all bots,
    so it must run even if you only use Gemini or the local bot
- **ollama** — the local model (downloads `qwen2.5:3b`, ~2 GB, on first start)

**One offer at a time per bot:**

- every 15 s, the workflow tries to take its bot's lock
- if a job is already running, it waits; your new messages stay queued in Telegram
- the offer is marked as read in Telegram *before* generating, so it is never processed twice
- the lock is released when the PDFs are sent (or right away if something fails)

---

## Files

| File | What it is |
|---|---|
| `docker-compose.yml` | all the containers |
| `main.py`, `Dockerfile` | the PDF compiler (LaTeX) |
| `prompts/profile.md` | **your profile** (plain text) |
| `prompts/prompts.js` | **all the prompts and settings**, shared by the three bots |
| `claude-bridge/` | the Claude bridge, prompt server and job locks |
| `cv-cover-letter-*.json` | the three n8n workflows |
| `.env.example` | settings template → copy to `.env` |
| `bots.sh` | choose which bots run |

---

## First-time setup

### 1. Settings

```bash
cp .env.example .env
```

Fill in `.env`:

- your contact details (`CV_*`)
- `CLAUDE_CODE_OAUTH_TOKEN` — only for the Claude bot:
  ```bash
  npm i -g @anthropic-ai/claude-code
  claude setup-token     # log in with your Pro account, copy the token
  ```
- `OLLAMA_MODEL` — only for the local bot (default `qwen2.5:3b`)

### 2. Start

```bash
docker volume create n8n_data
docker-compose up -d --build
```

Check: `docker ps` should list `n8n`, `xelatex-api`, `claude-bridge` and `ollama`.

> First start: `ollama` downloads its model (~2 GB) in the background.
> The local bot answers ❌ until it's done. Follow it with `docker-compose logs -f ollama`.

### 3. Create the Telegram bots

In Telegram, talk to **@BotFather** → `/newbot` → copy the token. One bot per engine you want.

### 4. Import the workflows into n8n

Open http://localhost:5678 → **Import from file** → pick a `cv-cover-letter-*.json`. Then in that workflow:

1. **Get Telegram Updates** and **Confirm Updates** → replace `YOUR_TELEGRAM_BOT_TOKEN` in the URL with the bot's token
2. Create a **Telegram credential** with the same token and select it on every Telegram node
   (Acknowledge Message, Send Resume PDF, Send Cover Letter PDF, Send ATS Report, Notify Failure)
3. Gemini only: create a **Google Gemini API** credential (key from https://aistudio.google.com) and select it on the 4 Gemini nodes
4. **Activate / publish** the workflow

Your profile goes in `prompts/profile.md` (see below), not in n8n.

> ⚠️ Never put the same Telegram bot in two active workflows: they would steal each other's messages.

---

## Daily use

| Do | Command |
|---|---|
| Start everything | `docker-compose up -d` |
| Stop everything | `docker-compose down` (workflows and settings are kept) |
| Follow the logs | `docker-compose logs -f` |
| After changing `main.py` or `claude-bridge/` | `docker-compose up -d --build` |
| After changing `OLLAMA_MODEL` in `.env` | `docker-compose up -d` (downloads the new model) |
| After editing `prompts/` | nothing, it applies on the next offer |

Then just send a job offer (more than 20 characters) to a bot.

### Choose which bots run

`bots.sh` starts the containers the chosen bots need, turns their workflows **on** in n8n and the others **off**:

| I want | Command |
|---|---|
| Only Claude | `./bots.sh claude` |
| Only Gemini | `./bots.sh gemini` |
| Only the local model | `./bots.sh local` |
| Two of them | `./bots.sh claude gemini` (any combination) |
| All three | `./bots.sh all` |
| Stop everything | `docker-compose down` |

- `ollama` only runs when the local bot is on (it frees ~2–3 GB of RAM otherwise).
- `claude-bridge` always runs: it serves the prompts and locks for every bot (no Claude usage unless the Claude bot is on).
- Your choice is remembered: a plain `docker-compose up -d` keeps the same bots on (but also starts `ollama`).

---

## RAM usage

Idle (nothing being generated), measured:

| Container | RAM |
|---|---|
| n8n | ~330 MB |
| ollama (model not loaded) | ~190 MB |
| xelatex-api | ~16 MB |
| claude-bridge | ~13 MB |
| **Total** | **~550 MB** |

While generating, on top of that (estimates):

| Activity | Extra RAM |
|---|---|
| Claude bot (Claude Code runs in the bridge) | +200–400 MB |
| PDF compilation (LaTeX) | +100–300 MB, a few seconds |
| Gemini bot | ~0 (runs on Google's servers) |
| **Local bot (`qwen2.5:3b`)** | **+2.5 GB** |

- Ollama keeps the model in RAM for 15 min after the last offer, then frees it.
- Claude and/or Gemini only: **under 1 GB**.
- With the local bot: **~3–3.5 GB** while generating. Fine on 8 GB, but close other heavy apps.
- `qwen2.5:7b` needs ~5–6 GB on its own: avoid it on an 8 GB machine.
- Not using the local bot? `./bots.sh claude gemini` stops `ollama` and frees its RAM.

---

## Customize

Everything is in the **`prompts/`** folder, shared by the three bots.
Edit, save, send an offer: changes apply right away (no restart, no re-import).

**`prompts/profile.md`** — your real profile (experience, skills, education…). The AI only starts from this.

**`prompts/prompts.js`** — settings at the top:

- **`TAILORING`**
  - `'aggressive'` (default) — job titles and tasks are rewritten to match the offer.
    Company names, dates, locations, education, certifications and "Intern" status are never changed. No invented numbers.
  - `'strict'` — only rephrases and reorders what is really in your profile.
- **`MODELS`**
  - `claude`: `'sonnet'` or `'haiku'` (lighter on your Pro limits)
  - `local`: comes from `OLLAMA_MODEL` in `.env`, e.g. `qwen2.5:7b` (better, but see [RAM usage](#ram-usage)). Change it, then `docker-compose up -d`.

Below the settings: `system` (general rules), `experienceRules`, `resumeTask` (the CV steps) and `letterTask` (the cover letter).

**Gemini model** — in the n8n **Gemini - … JSON** nodes. If it fails 3 times, the **(fallback)** nodes use `gemini-3.1-flash-lite`.

**Changed a workflow in n8n?** Export it (**⋯ → Download**) over its `cv-cover-letter-*.json` to keep the repo in sync.
Remove the bot token from the URLs before committing.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| ❌ *Build Prompts* failed | Syntax error in `prompts/prompts.js`, or `prompts/profile.md` is empty. The message says which |
| Only "Je traite cette offre..." and nothing else | Check `docker-compose logs -f n8n claude-bridge`, or the workflow's **Executions** tab in n8n |
| Same offer processed several times | Two active workflows use the same bot → deactivate one |
| Gemini: *"model is currently experiencing high demand"* | Google is overloaded (common on free keys). The fallback model kicks in; otherwise retry later |
| Claude: error 429 / limit | Your Pro usage limit is reached (shared with claude.ai). Wait, or set `claude: 'haiku'` in `MODELS` |
| Local bot: ❌ *model not found* / *connection refused* | Ollama is still downloading the model, or isn't running: `docker-compose logs -f ollama` |
| Local bot very slow | Normal on CPU. Use a smaller model (`qwen2.5:1.5b`) or the Claude/Gemini bot |
| A bot stays silent after a crash | Its lock frees itself after 30 min, or free it now: `docker-compose exec n8n wget -qO- --post-data='' 'http://claude-bridge:8080/unlock?key=claude'` (`gemini` / `local`) |
| `KeyError: 'ContainerConfig'` | Old docker-compose bug: `docker-compose down` then `docker-compose up -d` |

---

## Good to know

- **Claude Pro limits are shared** with your normal Claude use. Each offer = 2 generations.
- **Never set `ANTHROPIC_API_KEY`** in the bridge: you would be billed API prices.
- **Keep the bridge private** — it uses your personal subscription.
- **Your profile is in `prompts/profile.md`.** Remove it before publishing the repo.
- **Telegram tokens are secrets.** If one leaks: @BotFather → `/revoke`, then update the workflow.
