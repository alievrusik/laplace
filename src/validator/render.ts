import type {
  CriticReport,
  EmpiricalValidationResult,
  IdeaValidationReport,
  PrototypeValidationReport,
} from "./types.js";

const MAX_CHARS = 3900;

export function renderQuickIdeaSummary(report: IdeaValidationReport): string {
  const topSignals = report.criticReports
    .filter((item) => !item.abstained)
    .slice(0, 4)
    .map((item) => `- ${roleLabel(item)}: ${item.score.toFixed(1)}/10 (${Math.round(item.confidence * 100)}%)`)
    .join("\n");
  return [
    "Quick pre-validation",
    `Verdict: ${report.verdict}`,
    `Score: ${report.overallScore.toFixed(2)}/10 (conf ${Math.round(report.overallConfidence * 100)}%)`,
    `Prompt packs: ${Object.keys(report.promptVersions ?? {}).length}`,
    "",
    "Критики:",
    topSignals || "- нет данных",
  ].join("\n");
}

export function renderIdeaReport(report: IdeaValidationReport): string[] {
  const messages: string[] = [];
  const blockers = report.criticReports.flatMap((item) => item.findings).filter((item) => item.severity === "blocker").length;
  const warns = report.criticReports.flatMap((item) => item.findings).filter((item) => item.severity === "warn").length;
  const topActions = dedupe(
    report.criticReports.flatMap((item) => item.recommendations).map((item) => item.trim()).filter(Boolean),
  ).slice(0, 6);
  const promptTrace = Object.entries(report.promptVersions ?? {}).slice(0, 10).map(([id, version]) => `- ${id}@${version}`);
  messages.push([
    "Idea validation report",
    "",
    "Executive",
    `Verdict: ${report.verdict}`,
    `Score: ${report.overallScore.toFixed(2)}/10 (conf ${Math.round(report.overallConfidence * 100)}%)`,
    `Critics: ${report.criticReports.length}`,
    `Findings: blockers=${blockers}, warnings=${warns}`,
    `Prompt packs: ${Object.keys(report.promptVersions ?? {}).length}`,
    "",
    "Top actions:",
    ...(topActions.length ? topActions.map((item) => `- ${item}`) : ["- none"]),
    "",
    `Enriched prompt:\n${truncate(report.enrichedPrompt, 1400)}`,
  ].join("\n"));

  if (promptTrace.length) {
    messages.push(["Prompt trace", ...promptTrace].join("\n"));
  }

  for (const critic of report.criticReports) {
    messages.push(renderCritic(critic));
  }

  if (report.arbitration) {
    messages.push([
      "Arbitration",
      "",
      "Contradictions:",
      ...(report.arbitration.contradictions.length
        ? report.arbitration.contradictions.slice(0, 6).map((item) => `- ${item.topic}: ${item.resolution}`)
        : ["- Нет явных противоречий"]),
      "",
      "Consensus:",
      ...(report.arbitration.consensusPoints.length
        ? report.arbitration.consensusPoints.slice(0, 6).map((item) => `- ${item}`)
        : ["- Нет"]),
    ].join("\n"));
  }

  if (report.financialModel) {
    const fm = report.financialModel;
    messages.push([
      "Financial model",
      `TAM: ${fm.tamUsd.low}-${fm.tamUsd.high} USD`,
      `SAM: ${fm.samUsd.low}-${fm.samUsd.high} USD`,
      `SOM: ${fm.somUsd.low}-${fm.somUsd.high} USD`,
      `CAC: ${fm.unitEconomics.cac.low}-${fm.unitEconomics.cac.high}`,
      `LTV: ${fm.unitEconomics.ltv.low}-${fm.unitEconomics.ltv.high}`,
      `Runway: ${fm.burnRunway.runwayMonths} months`,
    ].join("\n"));
  }

  if (report.riskRegister?.entries.length) {
    messages.push([
      "Risk register",
      ...report.riskRegister.entries.slice(0, 8).map((entry) => `- [${entry.probability}/${entry.impact}] ${entry.statement}`),
    ].join("\n"));
  }

  if (report.investmentMemo) {
    messages.push([
      "Investment memo",
      `Recommendation: ${report.investmentMemo.recommendation}`,
      `${report.investmentMemo.rationale}`,
      "",
      "Top risks:",
      ...(report.investmentMemo.topRisks.length ? report.investmentMemo.topRisks.map((item) => `- ${item}`) : ["- Нет"]),
    ].join("\n"));
  }

  return chunkMessages(messages);
}

export function renderPrototypeReport(report: PrototypeValidationReport): string {
  const promptTrace = Object.entries(report.promptVersions ?? {}).slice(0, 10).map(([id, version]) => `- ${id}@${version}`);
  return [
    "Prototype audit report",
    "",
    "Executive",
    `matchesIntent: ${report.matchesIntent ? "yes" : "no"}`,
    `intentAlignmentScore: ${report.intentAlignmentScore}/10`,
    `coherenceScore: ${report.coherenceScore}/10`,
    `completenessScore: ${report.completenessScore}/10`,
    `needsRefinement: ${report.needsRefinement ? "yes" : "no"}`,
    `Prompt packs: ${Object.keys(report.promptVersions ?? {}).length}`,
    "",
    "Summary:",
    report.executiveSummary,
    "",
    "Technical",
    "Model findings:",
    ...(report.findings.length ? report.findings.slice(0, 8).map((item) => `- [${item.severity}] ${item.statement}`) : ["- none"]),
    "",
    "Static issues:",
    ...(report.staticAnalysisIssues.length
      ? report.staticAnalysisIssues.slice(0, 10).map((item) => `- ${item.category}: ${item.filePath}${item.line ? `:${item.line}` : ""} - ${item.message}`)
      : ["- None"]),
    ...(promptTrace.length ? ["", "Prompt trace:", ...promptTrace] : []),
    ...(report.refinementPrompt ? ["", "Refinement prompt:", report.refinementPrompt] : []),
  ].join("\n");
}

export function renderEmpiricalSection(empirical?: EmpiricalValidationResult): string[] {
  if (!empirical) return ["Empirical audit: not available"];
  if (empirical.status !== "completed") {
    return [`Empirical audit: ${empirical.status} - ${empirical.reason}`];
  }
  const report = empirical.report;
  return chunkMessages([[
    "Empirical audit",
    `Verdict: ${report.verdict}`,
    `Coverage: ${(report.coverage * 100).toFixed(1)}%`,
    `Schema compliance: ${(report.schemaCompliance * 100).toFixed(1)}%`,
    `Agreement mean: ${(report.agreement.mean * 100).toFixed(1)}%`,
    `Latency p50/p95/max: ${report.latency.p50.toFixed(0)}/${report.latency.p95.toFixed(0)}/${report.latency.max.toFixed(0)} ms`,
    report.groundTruthAccuracy !== undefined ? `Ground truth accuracy: ${(report.groundTruthAccuracy * 100).toFixed(1)}%` : "Ground truth accuracy: n/a",
    `Duration: ${report.durationSec.toFixed(1)} sec`,
    `Approx cost: $${report.approxCostUsd.toFixed(2)}`,
    "",
    "Recommendations:",
    ...(report.recommendations.length ? report.recommendations.map((item) => `- ${item}`) : ["- none"]),
  ].join("\n")]);
}

function renderCritic(critic: CriticReport): string {
  return [
    `${roleLabel(critic)}: ${critic.score.toFixed(1)}/10 (conf ${Math.round(critic.confidence * 100)}%)${critic.abstained ? " [abstained]" : ""}`,
    critic.summary,
    "",
    "Findings:",
    ...(critic.findings.length
      ? critic.findings.slice(0, 8).map((item) => `- [${item.severity}] ${item.statement}`)
      : ["- none"]),
    "",
    "Recommendations:",
    ...(critic.recommendations.length ? critic.recommendations.slice(0, 5).map((item) => `- ${item}`) : ["- none"]),
  ].join("\n");
}

function roleLabel(critic: CriticReport): string {
  return critic.role.replace(/_/g, " ");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function chunkMessages(messages: string[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    for (const chunk of splitText(message, MAX_CHARS)) out.push(chunk);
  }
  return out;
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const blocks = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    flush();
    if (block.length <= maxChars) {
      current = block;
      continue;
    }
    for (let i = 0; i < block.length; i += maxChars) {
      chunks.push(block.slice(i, i + maxChars));
    }
  }
  flush();
  return chunks;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
