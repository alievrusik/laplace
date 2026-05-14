# Project History

## 2026-05-07T15:18:15.291Z - create
Project: bad-roads
Summary: Builder finished and evaluator accepted bad-roads.
Evaluator: accepted (91/100) - Next.js prototype matches the brief: server-side text analysis with heuristic/LLM extraction, Nominatim geocoding, OSM map clustering, documented env vars, SAM3 proxy follows /sam3-image with x-api-key and English prompts; builds and lint/typecheck cleanly.
Repo: https://github.com/alievrusik/bad-roads
Deploy: https://bad-roads-8wqicqjq4-alievrusiks-projects.vercel.app
Notes:
- Deploy URL is attached after Vercel finishes the preview deployment.
- Production quality depends on configuring DEMO_FOUNDATION_PROVIDERS and LLM endpoints; without them the demo stays on heuristics.
- Nominatim polite-use limits and sequential geocoding can make long inputs slow or brittle.
- Multipart SAM3 requests append return_preview/return_overlay fields that the route handler does not read from FormData (defaults apply)—unlikely to block demos but worth aligning if upstream toggles matter.

---

## 2026-05-07T15:30:16.626Z - update
Project: bad-roads
Change request: Заменить неработающую интеграцию с OpenStreetMap в среде Vercel на альтернативное решение для визуализации данных. Сохранить функционал анализа комментариев социальных сетей для города Томск с целью выявления участков дорог с низким качеством, отображая на новой карте места и частоту упоминаний проблемных зон.
Summary: Change finished and evaluator accepted bad-roads.
Evaluator: accepted (88/100) - bad-roads implements Tomsk road-complaint text analysis with server-side geocoding (Photon then Nominatim), heuristic/LLM extraction, Leaflet+CARTO basemap (avoiding blocked OSM tiles on Vercel), plus a SAM3 image proxy consistent with `/sam3-image` and `x-api-key`. `npm install`, typecheck, lint, and production build succeed; `/api/analyze` returns geocoded items for sample Tomsk streets. README, prototype.md, and `.cursor/rules/laplace-prototype.md` are present and aligned.
Repo: https://github.com/alievrusik/bad-roads
Deploy: https://bad-roads-658mlpja1-alievrusiks-projects.vercel.app
Notes:
- Geocoding depends on external Photon/Nominatim availability and rate limits; long comment lists may approach the 60s `maxDuration`.
- Segmentation path was not exercised against a live Segmind endpoint (no `SAM3_*` keys in eval environment); only static code review plus missing-env behavior.
- Public copy still names basemap stack (“CARTO”, “OpenStreetMap”) in header/meta—acceptable for attribution but interpret strictly if ‘provider’ means any third-party brand.

---

## 2026-05-07T15:47:51.840Z - update
Project: bad-roads
Change request: 1. Заменить неработающий в Vercel OpenStreetMap на альтернативное решение для визуализации. 2. Реализовать получение реальных данных через OSM API Notes вместо тестовых заглушек. 3. Если реальных данных недостаточно, сгенерировать 100 реалистичных комментариев о дорогах Томска с помощью веб-поиска и явно маркировать их источник. 4. Исправить ошибку 'Anthropic proxy env not configured', добавив необходимую настройку переменных окружения для подключения к языковой модели.
Summary: Change finished and evaluator accepted bad-roads.
Evaluator: accepted (84/100) - Карта переведена на Leaflet с тайлами Esri/CARTO, демотекст тянется с серверного OSM Notes с резервом до 100 помеченных синтетических строк; сборка, линт и typecheck проходят; Anthropic больше не требует отдельного proxy URL. OSM в среде оценки отдал 429, поэтому живой поток заметок здесь не проверен; синтетика основана на статических формулировках, а не на рантайм веб-поиске.
Repo: https://github.com/alievrusik/bad-roads
Deploy: https://bad-roads-2f1148uxv-alievrusiks-projects.vercel.app
Notes:
- Rate limiting и доступность публичного OSM API могут часто включать синтетический режим на shared-хостингах.
- Точность геокодирования и извлечения адресов без настроенного языкового провайдера ограничена эвристиками.
- Сегментация SAM3 и прямые вызовы Anthropic не проверялись без реальных SAM3_API_* и ANTHROPIC_API_KEY.

---

## 2026-05-14T14:07:21.995Z - migration
Project: bad-roads
Summary: Deployment migrated from Vercel to Render.
Previous deploy: https://bad-roads-lbtl1nlbb-alievrusiks-projects.vercel.app
Current deploy: https://laplace-subprojects-bad-roads.onrender.com
Notes:
- Vercel resources are kept as legacy fallback.
