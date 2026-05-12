# Builder Task Prompt

Create a compact, client-facing AI/ML prototype from the structured brief.

The prototype should demonstrate a clear input-to-output transformation using a configured foundation model.

Requirements:

- Choose the frontend shape that fits the project; do not force a generic upload UI.
- Make all user-facing project content Russian by default (UI copy, form labels, errors, hints, README usage examples), unless the brief explicitly requests another language.
- Keep foundation model calls on the server side.
- Do not mention the specific foundation model provider in user-facing UI copy.
- Validate structured model output when possible.
- If the selected providers include `sam3`, use Segmind SAM3 Image: `POST ${SAM3_API_BASE_URL}/sam3-image` with `x-api-key: ${SAM3_API_KEY}`. Do not use `/segment` and do not use `Authorization: Bearer` for this API. Create a detection/segmentation flow with image upload, `text_prompt` classes, optional points/boxes, preview/overlay/mask handling, derived bounding boxes, confidence labels, and JSON/exportable metadata. Keep `SAM3_API_KEY` server-side.
- Keep UI in Russian by default, but for SAM3 send classes/`text_prompt` in English (or map RU classes to EN on the server before calling SAM3).
- By default, do not expose manual point/line/blob/box drawing controls in UI; add interactive refinement controls only when the user explicitly requests them.
- Parse multipart points/boxes/labels safely as JSON on server; do not forward raw stringified blobs as-is.
- Default user workflow to visual outputs (`return_preview` + `return_overlay`); treat `return_masks` as optional/advanced due to heterogeneous upstream formats.
- Handle response formats defensively: Segmind can return image/binary for preview/overlay flows and structured JSON-like payloads for mask-oriented flows. Normalize server response before rendering in UI.
- In normalization, accept both `data:` URLs and external image URLs for preview/overlay artifacts.
- If upstream returns only one visual output (only preview or only overlay), mirror it so both UI panes remain usable.
- Add robust fallback path: when upstream is unreachable or returns 200 with empty detections/masks, return a local visual fallback plus explicit warning instead of blank result.
- Return per-item diagnostics (e.g. `processingMode`, `outputKind`, `attemptUsed`, `upstreamStatus`) so failures are debuggable in Vercel logs and UI.
- Use Segmind only for segmentation/localization flows. Do not choose Segmind LLM, image generation, video generation, audio, or embedding models for non-segmentation requests.
- If multiple providers are selected, use each for its strongest role and keep the UI as one coherent demo, not separate provider demos.
- Prepare evaluator-ready project checks: local frontend start command, passing build/typecheck path, and a reproducible smoke flow in README (open app -> provide sample input -> trigger action -> verify output).
- Add `README.md`, `prototype.md`, and `.cursor/rules/laplace-prototype.md`.
- Prepare the project for Vercel preview deploy.
- Keep dependencies conservative and explain limitations clearly.
