# street-cleanliness-score

## Summary
Прототип оценки чистоты уличной сцены по фото: серверный vision-анализ возвращает шкалу 0–1000, факторы загрязнения, confidence и русскоязычное объяснение.

## Architecture Snapshot
- Stack: Next.js 14 App Router + TypeScript.
- Main flow: image upload -> `POST /api/analyze` -> server-only foundation vision call -> normalized JSON.
- UX: интерфейс на русском, число балла цветом, без отдельной легенды.
- Reliability: proxy support + JSON normalization/parsing layer.

## Interfaces
- Inputs: single street photo (jpeg/png/webp/gif, bounded size).
- Outputs: `cleanlinessScore`, `factors[]`, `confidence`, `explanation`, `warnings[]`.

## Links
- Repo: https://github.com/alievrusik/street-cleanliness-score
- Demo: https://street-cleanliness-score-676yoow68-alievrusiks-projects.vercel.app

## Notes
- Source: `prototype.md` в `laplace-workspace/street-cleanliness-score`.
- После следующего `/confirm` карточка будет обновлена runtime-результатом билдера/деплоя.
