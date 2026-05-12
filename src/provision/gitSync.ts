import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitSync {
  async push(args: {
    cwd: string;
    remoteUrl: string;
    branch?: string;
    message?: string;
    authorName: string;
    authorEmail: string;
  }): Promise<void> {
    const branch = args.branch ?? "main";
    await this.git(args.cwd, ["init"]);
    await this.git(args.cwd, ["checkout", "-B", branch]);
    await this.ensureRemote(args.cwd, args.remoteUrl);
    await this.git(args.cwd, ["add", "."]);

    const hasChanges = await this.hasStagedChanges(args.cwd);
    if (hasChanges) {
      await this.git(args.cwd, [
        "-c",
        `user.name=${args.authorName}`,
        "-c",
        `user.email=${args.authorEmail}`,
        "commit",
        "-m",
        args.message ?? "Create Laplace prototype",
      ]);
    }

    await this.git(args.cwd, ["push", "-u", "origin", branch]);
  }

  private async ensureRemote(cwd: string, remoteUrl: string): Promise<void> {
    try {
      await this.git(cwd, ["remote", "get-url", "origin"]);
      await this.git(cwd, ["remote", "set-url", "origin", remoteUrl]);
    } catch {
      await this.git(cwd, ["remote", "add", "origin", remoteUrl]);
    }
  }

  private async hasStagedChanges(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ["diff", "--cached", "--quiet"]);
      return false;
    } catch {
      return true;
    }
  }

  private async git(cwd: string, args: string[]): Promise<void> {
    try {
      await execFileAsync("git", args, { cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(" ")} failed: ${message}`);
    }
  }
}
