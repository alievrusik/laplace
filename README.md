# Laplace

Laplace is a local multi-agent assistant for rapid AI/ML prototype delivery.

Current scope:

- Telegram polling bot
- Telegram Mini App backend (`/` + `/api/*`) for project-dialog UX
- admin/client communication profiles
- `debug` / `user` workflow observability mode + heartbeat
- role-based agent orchestration (`brief`, `skeptic`, `builder`, `tester`, `revisor`, `estimator`)
- Markdown prototype memory
- Cursor SDK runtime adapter behind provider-agnostic contracts
- GitHub repository provisioning
- Render deployment pipeline + artifact snapshots
- feasibility gate (`feasible_now` / `needs_scope_reduction` / `not_feasible_now`)
- GigaChat STT + embeddings provider integration (env-driven)

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

This starts:
- Telegram bot (polling)
- Mini App backend (default `http://localhost:4310`)

## Render Deployment

- Main service (`Laplace-prod`) can be bootstrapped from `render.yaml`.
- Set `DEPLOY_PROVIDER=render`, `RENDER_API_KEY`, `RENDER_PROJECT_NAME=Laplace-prod`, `RENDER_SUBPROJECT_NAME=Laplace-subprojects`.
- Mini App should use public HTTPS URL via `TELEGRAM_MINIAPP_BASE_URL` (or same-origin in Render Web Service).
- Runtime port prefers `PORT` (Render default) and falls back to `TELEGRAM_MINIAPP_PORT`.

## Required Secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_USER_IDS`
- `LAPLACE_LLM_API_KEY`
- `CURSOR_API_KEY`
- `GITHUB_TOKEN`
- `DEPLOY_PROVIDER` (`render` or `vercel`)
- `RENDER_API_KEY` when `DEPLOY_PROVIDER=render`
- `ANTHROPIC_API_KEY` when deployed demos use Anthropic
- `PROXY` and `PROXY_CA_CERT_PATH` if Telegram/Anthropic should go through the same HTTPS proxy
- `GIGACHAT_*` variables for STT/embeddings integration (when enabled)
- `VERCEL_TOKEN` only for legacy fallback or migration scripts

## Useful Commands

- `npm run typecheck` - TypeScript validation
- `npm run test:runtime-harness` - runtime adapter compatibility + model policy checks
- `npm run test:regressions` - survey/history regression scenarios
- `npm run migrate:render -- --limit 5` - dry-run migration sample (use `--apply` to execute)

## Mini App Endpoints

- `GET /health`
- `GET /` - Mini App shell
- `GET /api/dialog/state`, `/api/messages`, `/api/workflow`, `/api/artifact`
- `POST /api/dialog/new`, `/api/dialog/switch`, `/api/mode`
- `POST /api/chat/send`
- `POST /api/action/analyze`, `/api/action/confirm`, `/api/action/estimate`
- `POST /api/gigachat/embed`, `/api/gigachat/stt`

## Notes

Public cloud deployments (Render/Vercel) cannot reach private `172.*` vLLM addresses. Use Anthropic for deployed demo inference, or expose vLLM through a protected public gateway later.

`PROXY` is a shared fallback for Telegram and Anthropic. Use `TELEGRAM_PROXY_URL` or `ANTHROPIC_PROXY_URL` only when they need different proxy routes.
