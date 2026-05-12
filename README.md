# Laplace

Laplace is a local Telegram assistant for rapid AI/ML prototype delivery.

MVP scope:

- Telegram polling bot
- admin/client communication profiles
- local vLLM-backed Laplace Chat Agent
- Markdown prototype memory
- Cursor SDK Project Builder using `composer-2`
- GitHub repository provisioning
- Vercel preview project provisioning
- first demo path: counting penguins in a photo

## Setup

1. Copy `.env.example` to `.env`.
2. Fill local secrets in `.env`.
3. Revoke any tokens that were pasted into chat and use newly generated ones.
4. Install dependencies:

```bash
npm install
```

5. Start in polling mode:

```bash
npm run dev
```

## Required Secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_USER_IDS`
- `LAPLACE_LLM_API_KEY`
- `CURSOR_API_KEY`
- `GITHUB_TOKEN`
- `VERCEL_TOKEN`
- `ANTHROPIC_API_KEY` when deployed demos use Anthropic
- `PROXY` and `PROXY_CA_CERT_PATH` if Telegram/Anthropic should go through the same HTTPS proxy

## Notes

Vercel cannot reach private `172.*` vLLM addresses from public deployments. Use Anthropic for deployed demo inference, or expose vLLM through a protected public gateway later.

`PROXY` is a shared fallback for Telegram and Anthropic. Use `TELEGRAM_PROXY_URL` or `ANTHROPIC_PROXY_URL` only when they need different proxy routes.
