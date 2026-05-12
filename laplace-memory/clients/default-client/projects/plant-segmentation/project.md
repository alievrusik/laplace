# plant-segmentation

## Summary
Эталонный прототип сегментации растений: загрузка изображения, server-side вызов сегментационного API, визуализация overlay/preview/контуров и экспорт результатов в JSON.

## Architecture Snapshot
- Stack: Next.js + TypeScript.
- Main flow: UI upload -> server segmentation route -> normalized visual artifacts -> result view.
- Integration: SAM3 API (configurable path/auth/body режимами через env).
- Quality gates: typecheck/build/lint + browser smoke сценарий.

## Interfaces
- Inputs: image upload.
- Outputs: segmentation preview/overlay/contours + JSON export.

## Links
- Repo: not available
- Demo: not available

## Notes
- Source: `README.md` в `laplace-workspace/plant-segmentation`.
- После следующего `/confirm` карточка будет обновлена runtime-результатом билдера/деплоя.
