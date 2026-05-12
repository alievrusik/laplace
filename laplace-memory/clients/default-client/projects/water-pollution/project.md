# water-pollution

## Summary
Прототип сегментации водных зон на спутниковых снимках: пользователь загружает изображения, сервер выделяет водные области zero-shot сегментацией и возвращает визуальные маски/оверлеи для ручной оценки.

## Architecture Snapshot
- Stack: Next.js + TypeScript.
- Main flow: image batch upload -> server segmentation route -> response normalization -> mask/overlay rendering in UI.
- Segmentation mode: promptable water segmentation без обучающего датасета.
- Output includes visual artifacts and structured JSON (detections/masks/boxes/warnings).

## Interfaces
- Inputs: JPG/PNG images + text prompt/class for segmentation.
- Outputs: mask preview/overlay, exported JSON with segmentation metadata.

## Links
- Repo: https://github.com/alievrusik/water-pollution
- Demo: https://water-pollution-e6sto6dwl-alievrusiks-projects.vercel.app

## Notes
- Source: `prototype.md` в `laplace-workspace/water-pollution`.
- После следующего `/confirm` карточка будет обновлена runtime-результатом билдера/деплоя.
