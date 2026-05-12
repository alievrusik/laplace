import type { BuilderResult, JobStatus, ProjectBrief } from "../domain/types.js";

export interface Job {
  id: string;
  status: JobStatus;
  brief: ProjectBrief;
  result?: BuilderResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private activeJobId: string | undefined;

  create(brief: ProjectBrief): Job {
    const now = new Date();
    const job: Job = {
      id: `job_${now.getTime()}`,
      status: "queued",
      brief,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  async run(id: string, task: (job: Job) => Promise<BuilderResult>): Promise<Job> {
    if (this.activeJobId) {
      throw new Error(`Another builder job is already running: ${this.activeJobId}`);
    }

    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);

    this.activeJobId = id;
    this.update(job, { status: "running" });

    try {
      const result = await task(job);
      this.update(job, { status: "finished", result });
    } catch (error) {
      this.update(job, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeJobId = undefined;
    }

    return job;
  }

  private update(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch, { updatedAt: new Date() });
  }
}
