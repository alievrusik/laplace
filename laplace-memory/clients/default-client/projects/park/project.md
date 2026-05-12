# park

## Summary
Builder finished and evaluator accepted park.

## Demo Scenario
User selects a simulated camera feed or uploads a short video clip; the system processes the visual data and displays a dashboard with tabs for Demographics, Activities, and Facility Usage, including charts and summaries in Russian.

## Inputs
Video file upload or selection of a pre-defined camera stream simulation.

## Domain
AI/ML prototype

## Task Type
vision

## Output
Interactive dashboard with tabs showing: visitor groups (families, youth, couples, pet owners, athletes), popular activities, facility heatmaps, and daily trend charts. All text in Russian, light theme.

## Approach
Use a vision-capable foundation model to analyze key frames from the video, identify people/groups/activities, and generate structured JSON data for the dashboard charts.

## Build Status
- Evaluator: accepted (84/100)
- Evaluator summary: Park Next.js прототип соответствует брифу: симуляция/загрузка → POST /api/analyze с кадрами → русскоязычный дашборд с вкладками и Recharts; сборка/typecheck/lint проходят. Сегментация SAM3 отсутствует (условные критерии SAM3 не задействованы). Найден пробел устойчивости при настроенном ключе при сбое TLS.

## Reuse Notes
Can be used as a starting point for similar vision prototypes.

## Links
- Repo: https://github.com/alievrusik/park
- Demo: https://park-b3ibgxms0-alievrusiks-projects.vercel.app

## Limitations
- Deploy URL is attached after Vercel finishes the preview deployment.
- Поведение с реальным ANTHROPIC_API_KEY и корпоративным MITM/самоподписанным сертификатом без корректного ANTHROPIC_PROXY_CA_CERT_BASE64 остаётся хрупким до исправления обработки ошибок.
- Качество vision-ответа и парсинг JSON с реального апстрима не проверялись в этом прогоне (нет валидного ключа/сети).
- Интерактивные графики после гидратации React не проверялись визуально в браузере.
