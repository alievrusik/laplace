import type {
  BuilderResult,
  JobStatus,
  ProjectBrief,
  WorkflowEvent,
  WorkflowStage,
} from "../domain/types.js";

export interface Job {
  id: string;
  status: JobStatus;
  brief: ProjectBrief;
  stage: WorkflowStage;
  workflowEvents: WorkflowEvent[];
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
      stage: "intake",
      workflowEvents: [],
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
    this.pushWorkflowEvent(id, {
      jobId: id,
      stage: "intake",
      kind: "agent_started",
      sourceAgent: "agent_brief",
      message: "Job started",
      isIntermediate: true,
      isFinal: false,
      createdAt: new Date().toISOString(),
    });

    try {
      const result = await task(job);
      this.update(job, { status: "finished", stage: "done", result });
      this.pushWorkflowEvent(id, {
        jobId: id,
        stage: "done",
        kind: "final",
        message: "Job finished",
        isIntermediate: false,
        isFinal: true,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      this.update(job, {
        status: "failed",
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.pushWorkflowEvent(id, {
        jobId: id,
        stage: "failed",
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        isIntermediate: false,
        isFinal: true,
        createdAt: new Date().toISOString(),
      });
    } finally {
      this.activeJobId = undefined;
    }

    return job;
  }

  private update(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch, { updatedAt: new Date() });
  }

  updateStage(id: string, stage: WorkflowStage): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.update(job, { stage });
  }

  pushWorkflowEvent(id: string, event: WorkflowEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.workflowEvents.push(event);
    job.workflowEvents = job.workflowEvents.slice(-200);
    job.updatedAt = new Date();
  }

  getWorkflowEvents(id: string): WorkflowEvent[] {
    return this.jobs.get(id)?.workflowEvents ?? [];
  }
}
