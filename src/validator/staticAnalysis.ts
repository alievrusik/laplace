import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { StaticAnalysisIssue } from "./types.js";

export class StaticAnalyzer {
  async analyze(projectDir: string): Promise<StaticAnalysisIssue[]> {
    const issues: StaticAnalysisIssue[] = [];
    issues.push(...await this.checkPackage(projectDir));
    issues.push(...await this.checkTypeScript(projectDir));
    issues.push(...await this.scanPlaceholders(projectDir));
    return issues.slice(0, 60);
  }

  private async checkPackage(projectDir: string): Promise<StaticAnalysisIssue[]> {
    const target = path.join(projectDir, "package.json");
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8")) as { scripts?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      const issues: StaticAnalysisIssue[] = [];
      if (!scripts.build) issues.push({ filePath: "package.json", category: "missing_dependency", message: "Отсутствует build script." });
      if (!scripts.dev && !scripts.start) issues.push({ filePath: "package.json", category: "missing_dependency", message: "Нет start/dev script." });
      return issues;
    } catch {
      return [{ filePath: "package.json", category: "missing_dependency", message: "package.json не найден или поврежден." }];
    }
  }

  private async checkTypeScript(projectDir: string): Promise<StaticAnalysisIssue[]> {
    const tsconfig = path.join(projectDir, "tsconfig.json");
    try {
      await fs.access(tsconfig);
    } catch {
      return [];
    }
    const configText = await fs.readFile(tsconfig, "utf8");
    const config = ts.parseConfigFileTextToJson(tsconfig, configText);
    if (config.error) return [{ filePath: "tsconfig.json", category: "syntax_error", message: ts.flattenDiagnosticMessageText(config.error.messageText, "\n") }];
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectDir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    return diagnostics.slice(0, 30).map((diag) => ({
      filePath: diag.file?.fileName ? path.relative(projectDir, diag.file.fileName) : "tsc",
      line: diag.file && diag.start !== undefined ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1 : undefined,
      category: diag.category === ts.DiagnosticCategory.Error ? "type_error" : "import_error",
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
    }));
  }

  private async scanPlaceholders(projectDir: string): Promise<StaticAnalysisIssue[]> {
    const files = await collectCodeFiles(projectDir);
    const issues: StaticAnalysisIssue[] = [];
    for (const filePath of files.slice(0, 250)) {
      const raw = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split("\n");
      lines.forEach((line, idx) => {
        if (/TODO/i.test(line) && /(critical|must|fix|prod|bug)/i.test(line)) {
          issues.push({
            filePath: path.relative(projectDir, filePath),
            line: idx + 1,
            category: "todo_in_critical_path",
            message: "Critical TODO найден в коде.",
          });
        }
        if (/not implemented/i.test(line) || /placeholder/i.test(line)) {
          issues.push({
            filePath: path.relative(projectDir, filePath),
            line: idx + 1,
            category: "placeholder_logic",
            message: "Placeholder логика в коде.",
          });
        }
      });
    }
    return issues;
  }
}

async function collectCodeFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", ".next", "build", ".vercel"]);
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(projectDir);
  return out;
}
