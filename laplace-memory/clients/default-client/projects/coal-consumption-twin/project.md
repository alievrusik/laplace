# coal-consumption-twin

## Summary
Прототип цифрового двойника расхода угля для парка котлов: рассчитывает агрегированный расход, запас по дням, дефицит на горизонте и узлы риска, добавляя narrative/объяснение от foundation model.

## Architecture Snapshot
- Stack: Next.js, TypeScript.
- Core logic: deterministic simulation in backend (`/api/simulate`) + optional model-generated explanation.
- UX focus: операторский интерфейс на русском, ориентированный на планирование запасов.
- Reliability: детерминированный fallback при проблемах с внешним model API.

## Interfaces
- Inputs: daily consumption per boiler, shared reserve in tons, forecast horizon.
- Outputs: aggregate burn, runway days, shortfall tons, units at risk, confidence/explanation/warnings.

## Links
- Repo: https://github.com/alievrusik/coal-consumption-twin
- Demo: https://coal-consumption-twin-qtotvycoa-alievrusiks-projects.vercel.app

## Notes
- Source: `prototype.md` в `laplace-workspace/coal-consumption-twin`.
- После следующего `/confirm` карточка будет обновлена runtime-результатом билдера/деплоя.
