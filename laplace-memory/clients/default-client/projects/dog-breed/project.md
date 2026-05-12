# dog-breed

## Summary
Веб-прототип для анализа фото собаки: определяет породу и отображает сегментацию (overlay/preview/masks). Классификация идет через foundation vision, сегментация через Segmind SAM3.

## Architecture Snapshot
- Stack: Next.js 14, TypeScript.
- Main flow: image upload -> server routes -> breed classification + SAM3 segmentation -> unified UI result.
- Provider split: LLM/vision для breed, Segmind SAM3 Image (`POST /sam3-image`, `x-api-key`) для сегментации.
- Fallback: demo/mock режим при недоступности внешних API.

## Interfaces
- Inputs: image upload (jpeg/png/webp/gif).
- Outputs: breed label + segmentation artifacts (`overlayDataUrl`, `previewDataUrl`, `maskDataUrls`).

## Links
- Repo: https://github.com/alievrusik/dog-breed
- Demo: https://dog-breed-7yigmc3jd-alievrusiks-projects.vercel.app

## Notes
- Source: `prototype.md` в `laplace-workspace/dog-breed`.
- После следующего `/confirm` карточка будет обновлена runtime-результатом билдера/деплоя.
