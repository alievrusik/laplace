import type { BudgetEstimate, ProjectBrief } from "../domain/types.js";

export class BudgetGuard {
  estimatePrototype(brief: ProjectBrief): BudgetEstimate {
    const notes: string[] = [];

    notes.push("One Cursor builder run with composer-2.");
    notes.push(`Demo foundation providers: ${brief.recommendedFoundationProviders.join(", ")}.`);

    if (brief.taskType === "vision") {
      notes.push("Vision API usage should be limited to one image at a time in the MVP.");
    }

    return {
      risk: brief.taskType === "vision" ? "medium" : "low",
      requiresConfirmation: true,
      notes,
    };
  }
}
