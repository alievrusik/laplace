# Project History

## 2026-05-06T00:00:00.000Z - bootstrap
Project history initialized from existing workspace state.

---

## 2026-05-06T15:19:39.543Z - update
Project: satellite-water-pollution-demo
Change request: Обновить зависимости и конфигурацию текущего проекта, затем выполнить полную пересборку.
Summary: Change finished and evaluator accepted satellite-water-pollution-demo.
Evaluator: accepted (88/100) - Сборка, типизация и линт проходят; продакшен-сервер отдаёт рабочий UI и серверные маршруты SAM3/LLM соответствуют конвенциям (sam3-image, x-api-key, EN text_prompt из пресетов). `npm run dev` в этой сессии дал 500 после `next build` из‑за битого состояния `.next`; обязательный протокол закрыт через `npm run start`.
Repo: https://github.com/alievrusik/satellite-water-pollution-demo
Deploy: https://satellite-water-pollution-demo-6ispt007o-alievrusiks-projects.vercel.app
Notes:
- Конфликт/рассинхрон артефактов `.next` между `next build` и `next dev` может снова сломать dev до ручной очистки каталога.
- Сегментация в mock без ключа не проверяет живой ответ Segmind; для полного e2e нужен валидный `SEGMIND_API_KEY`.
- npm audit сообщает 2 moderate (transitive; в README уже отмечено ограничение fix без force).

---

## 2026-05-14T14:18:03.423Z - migration
Project: satellite-water-pollution-demo
Summary: Deployment migrated from Vercel to Render.
Previous deploy: https://satellite-water-pollution-demo-hsvp83yjj-alievrusiks-projects.vercel.app
Current deploy: https://laplace-subprojects-satellite-water.onrender.com
Notes:
- Vercel resources are kept as legacy fallback.
