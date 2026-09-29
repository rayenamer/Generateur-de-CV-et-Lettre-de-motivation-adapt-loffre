# CV & Cover Letter Generator

## What
Send a job offer to a Telegram bot → get back a tailored CV and cover letter as PDFs.

## How
```
Telegram → n8n → claude-bridge (Claude Code, Pro plan) → xelatex-api → PDFs → Telegram
```
- **n8n**: orchestrates the workflow (`cv-cover-letter-claude-pro.json`).
- **claude-bridge**: runs `claude -p` with your Pro login, exposes `POST /v1/messages` on `:8080`. No API key needed.
- **xelatex-api**: FastAPI (`main.py`) compiling `/compile-resume` and `/compile-cover-letter` to PDF on `:8000`.

## Setup
1. Get a Claude Code token: `npm i -g @anthropic-ai/claude-code && claude setup-token`
2. `cp .env.example .env`, fill in your details and add `CLAUDE_CODE_OAUTH_TOKEN=<token>`.
3. Start:
   ```bash
   docker volume create n8n_data
   docker compose up -d --build
   ```
4. Check the bridge: `docker compose exec n8n wget -qO- http://claude-bridge:8080/health` → `{"ok":true}`
5. Open n8n at http://localhost:5678, import `cv-cover-letter-claude-pro.json`, paste your profile into **Build Prompts**, and set your Telegram bot credentials.

## Notes
- Uses your Pro plan limits (2 generations per offer). Set `MODEL` to `haiku` in Build Prompts to save quota.
- Never set `ANTHROPIC_API_KEY` in the bridge (it would bill API rates). Don't expose the bridge publicly.
- More details: [report.md](report.md)
