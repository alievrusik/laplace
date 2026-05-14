import type { ProjectBrief, PublicDataHint } from "../domain/types.js";

export class PublicDataScoutAgent {
  async collect(args: { brief: ProjectBrief; sourceText: string }): Promise<PublicDataHint[]> {
    const taskType = args.brief.taskType;
    const source = `${args.sourceText}\n${args.brief.goal}\n${args.brief.demoScenario}`.toLowerCase();

    if (taskType === "vision" || /satellite|спутник|изображ|камера|video/.test(source)) {
      return [
        {
          title: "Roboflow Universe Datasets",
          url: "https://universe.roboflow.com/",
          whyUseful: "Open image datasets for rapid prototype smoke tests and UI validation.",
        },
        {
          title: "xView Satellite Dataset",
          url: "https://xviewdataset.org/",
          whyUseful: "Public satellite imagery benchmark for localization-like scenarios.",
        },
      ];
    }

    if (taskType === "language" || /document|pdf|faq|support|звонок|текст/.test(source)) {
      return [
        {
          title: "Hugging Face Datasets Hub",
          url: "https://huggingface.co/datasets",
          whyUseful: "Public text/document datasets for retrieval and summarization demos.",
        },
        {
          title: "Kaggle Datasets",
          url: "https://www.kaggle.com/datasets",
          whyUseful: "Large catalog of open structured and unstructured demo datasets.",
        },
      ];
    }

    return [
      {
        title: "UCI Machine Learning Repository",
        url: "https://archive.ics.uci.edu/",
        whyUseful: "Reliable fallback source for tabular baseline prototypes and quick benchmarks.",
      },
    ];
  }
}
