# satellite-water-pollution-demo

## Latest Change
Обновить зависимости и конфигурацию текущего проекта, затем выполнить полную пересборку.

## Update Result
Change finished and evaluator accepted satellite-water-pollution-demo.

## Evaluator
accepted (88/100) - Сборка, типизация и линт проходят; продакшен-сервер отдаёт рабочий UI и серверные маршруты SAM3/LLM соответствуют конвенциям (sam3-image, x-api-key, EN text_prompt из пресетов). `npm run dev` в этой сессии дал 500 после `next build` из‑за битого состояния `.next`; обязательный протокол закрыт через `npm run start`.

## Links
- Repo: https://github.com/alievrusik/satellite-water-pollution-demo
- Demo: https://satellite-water-pollution-demo-6ispt007o-alievrusiks-projects.vercel.app

## Notes
- Конфликт/рассинхрон артефактов `.next` между `next build` и `next dev` может снова сломать dev до ручной очистки каталога.
- Сегментация в mock без ключа не проверяет живой ответ Segmind; для полного e2e нужен валидный `SEGMIND_API_KEY`.
- npm audit сообщает 2 moderate (transitive; в README уже отмечено ограничение fix без force).
