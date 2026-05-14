# Project History

## 2026-05-06T00:00:00.000Z - bootstrap
Project history initialized from existing workspace state.

---

## 2026-05-06T14:42:39.499Z - update
Project: penguin-counter
Change request: Пользователь запрашивает перезапуск текущего проекта без внесения изменений в функционал или интерфейс.
Summary: Change finished and evaluator accepted penguin-counter.
Evaluator: accepted (90/100) - The Penguin Counter Next.js app implements the documented upload→server-side vision model→structured JSON result flow; production build and lint succeed; documentation and Laplace rules are present and aligned; there is no SAM3 segmentation path in this codebase so Segmind SAM3-specific rejection criteria do not apply. Mandatory frontend checks were satisfied by running a fresh production server and inspecting served HTML plus exercising the same multipart POST the UI performs.
Repo: https://github.com/alievrusik/penguin-counter
Deploy: https://penguin-counter-cjby4yz4i-alievrusiks-projects.vercel.app
Notes:
- Operational dependence on Anthropic or vLLM availability and on optional HTTPS proxy/CA configuration for outbound foundation calls.
- Species normalization maps English keyed JSON per prompt; arbitrary Cyrillic-only species tokens would fall back to unknown unless added as aliases (prompt mitigates by requiring English keys).

---

## 2026-05-14T14:15:44.329Z - migration
Project: penguin-counter
Summary: Deployment migrated from Vercel to Render.
Previous deploy: https://penguin-counter-cjby4yz4i-alievrusiks-projects.vercel.app
Current deploy: https://laplace-subprojects-penguin-counter.onrender.com
Notes:
- Vercel resources are kept as legacy fallback.
