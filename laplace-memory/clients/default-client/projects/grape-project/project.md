# grape-project

## Summary
Builder finished and evaluator accepted grape-project.

## Demo Scenario
User uploads or pastes a vine photo (or picks from bundled open-license examples); the app returns JSON with 1–3 ranked cultivar hypotheses, visible signs phrased as similarity to known issues, and coarse phenology classes inferred from the image, plus short rationales.

## Inputs
One static photo per request: grapevine canopy or row in general/plan view (smartphone or field camera); optional short note (location, month) ignored for MVP logic unless later added.

## Domain
AI/ML prototype

## Task Type
vision

## Output
Structured JSON: ranked_list (1–3 entries with cultivar_hypothesis, confidence_band, rationale); visible_symptoms as symptom_descriptions each phrased as signs similar_to named conditions (non-diagnostic); phenology_coarse_class among a small fixed set inferred visually (e.g. dormant, bud swell, flowering, fruit set, veraison, harvest window, post-harvest) with uncertainty; optional evidence bullets tied to visible plant parts.

## Approach
Use the configured multimodal foundation model to inspect the image and emit calibrated, structured hypotheses and symptom similarity labels; no custom training or disease confirmation in MVP.

## Build Status
- Evaluator: accepted (90/100)
- Evaluator summary: Tester+Revisor accepted. Tester: Next.js app implements the grape vision brief end-to-end: Russian UI with upload/paste, example gallery, server POST /api/analyze returning structured JSON plus SAM3-style segmentation fields; typecheck/lint/build pass; SAM3 uses POST /sam3-image with x-api-key and English text_prompt; secrets stay server-side with documented .env.example.; Revisor: Интерфейс и поток соответствуют сценарию (загрузка/вставка, примеры, анализ, экспорт JSON); сервер отдаёт нужную схему и понятные предупреждения при сбоях. Документация описывает смок и ограничения MVP; визуальная локализация оформлена тремя панелями. Небольшие расхождения с формулировкой deliverables про open-source фото и смесь RU/EN в подписях.

## Reuse Notes
Can be used as a starting point for similar vision prototypes.

## Links
- Repo: https://github.com/alievrusik/grape-project
- Demo: https://grape-project-k63q3g6g2-alievrusiks-projects.vercel.app

## Limitations
- Deploy URL is attached after deployment provider finishes the preview deployment.
- При «пустом» или нестабильном ответе SAM3 интерфейс опирается на синтетическую область и дубликат исходника в превью/наложении — полезно для смока, но не гарантирует осмысленную сегментацию.
- Качество демонстрации сценария для стейкхолдеров зависит от корректной настройки ANTHROPIC_* без credentials в URL и наличия ключей; иначе демонстрируется в основном fallback JSON.
- Если нужна формальная выверка списка deliverables, возможно понадобится заменить/дополнить синтетику реальными кадрами с открытой лицензией в public/examples и manifest.json.
