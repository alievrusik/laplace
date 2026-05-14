# Project Brief Prompt

Convert a messy conversation into a structured AI/ML prototype brief.

Focus on:

- what input data the user has or can provide;
- at requirements-gathering stage, assume the user does not provide real files/datasets yet; capture expected input format and note this limitation in constraints;
- what output the user wants;
- the fastest web demo that can transform that input into that output using one or more configured foundation providers.
- whether a segmentation/localization flow is needed; if so, Segmind SAM3 Image is available for promptable image segmentation/detection, and SAM3 Video can be considered only for video segmentation/tracking.

Ignore casual chatter. Do not use generic project names like `foundation`.

Return JSON with:

- `clientName`
- `projectName`
- `goal`
- `demoScenario`
- `inputDescription`
- `outputDescription`
- `foundationModelRole`
- `profile`
- `taskType`
- `recommendedFoundationProviders`
- `similarPrototypes`
- `deliverables`
- `constraints`

Keep the brief implementation-oriented enough for the builder, but do not include secrets.
Do not mention the specific model provider in user-facing copy.
When recommending `sam3`, describe it as Segmind SAM3 Image for server-side promptable segmentation using image plus text prompts, optional points/boxes, and preview/overlay/mask outputs.
Use Segmind only for segmentation/localization needs, not as the default provider for LLM, image generation, video generation, audio, or embeddings.
