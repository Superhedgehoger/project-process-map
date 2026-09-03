import { randomUUID } from "node:crypto";
import type { BackgroundJob, OutboxMessage } from "../../../packages/domain/src/events.ts";
import type { JobConsumer, OutboxConsumer } from "../../../packages/application/src/ports/persistence.ts";

export type WorkerDependencies = Readonly<{
  outbox: OutboxConsumer;
  jobs: JobConsumer;
  publish?: (message: OutboxMessage) => Promise<void>;
  processJob?: (job: BackgroundJob) => Promise<void>;
}>;

export type WorkerOptions = Readonly<{
  workerId?: string;
  batchSize?: number;
  leaseMilliseconds?: number;
  now?: () => Date;
}>;

export function startWorker(
  dependencies: WorkerDependencies,
  intervalMilliseconds: number,
  log: (message: string) => void = console.log,
  options: WorkerOptions = {},
): { stop(): void; runOnce(): Promise<void> } {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) throw new Error("Worker heartbeat must be positive");
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  let current: Promise<void> | undefined;
  const runOnce = async (): Promise<void> => {
    if (current !== undefined) return await current;
    current = (async () => {
      try {
        const summary = await runWorkerCycle(dependencies, { ...options, workerId });
        log(JSON.stringify({ component: "worker", status: "ok", workerId, ...summary }));
      } catch (error) {
        log(JSON.stringify({ component: "worker", status: "degraded", workerId, message: errorMessage(error) }));
      } finally {
        current = undefined;
      }
    })();
    return await current;
  };
  log(JSON.stringify({ component: "worker", status: "ready", workerId }));
  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, intervalMilliseconds);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce };
}

export async function runWorkerCycle(
  dependencies: WorkerDependencies,
  options: WorkerOptions & { workerId: string },
): Promise<{ checkedAt: string; outboxProcessed: number; jobsProcessed: number }> {
  const now = (options.now ?? (() => new Date()))();
  const nowUtc = now.toISOString();
  const leaseUntilUtc = new Date(now.getTime() + (options.leaseMilliseconds ?? 30_000)).toISOString();
  const batchSize = options.batchSize ?? 20;
  const outbox = await dependencies.outbox.claim({ workerId: options.workerId, nowUtc, leaseUntilUtc, limit: batchSize });
  let outboxProcessed = 0;
  for (const message of outbox) {
    try {
      await (dependencies.publish ?? noOpPublish)(message);
      if (message.leaseToken !== null && await dependencies.outbox.markPublished(message.tenantId, message.id, message.leaseToken, nowUtc)) {
        outboxProcessed += 1;
      }
    } catch (error) {
      if (message.leaseToken !== null) await dependencies.outbox.release(
        message.tenantId, message.id, message.leaseToken, nextAttempt(now, message.attempts), errorMessage(error),
      );
    }
  }

  const jobs = await dependencies.jobs.claim({ workerId: options.workerId, nowUtc, leaseUntilUtc, limit: batchSize });
  let jobsProcessed = 0;
  for (const job of jobs) {
    try {
      if (dependencies.processJob === undefined) throw new Error(`NO_JOB_PROCESSOR:${job.jobType}`);
      await dependencies.processJob(job);
      if (job.leaseToken !== null && await dependencies.jobs.markCompleted(job.tenantId, job.id, job.leaseToken, nowUtc)) jobsProcessed += 1;
    } catch (error) {
      if (job.leaseToken !== null) {
        if (isExplicitlyNonRetryable(error)) {
          await dependencies.jobs.markDeadLetter(job.tenantId, job.id, job.leaseToken, errorMessage(error));
        } else {
          await dependencies.jobs.release(
            job.tenantId, job.id, job.leaseToken, nextAttempt(now, job.attempts), errorMessage(error),
          );
        }
      }
    }
  }
  return { checkedAt: nowUtc, outboxProcessed, jobsProcessed };
}

async function noOpPublish(_message: OutboxMessage): Promise<void> {}

function nextAttempt(now: Date, attempts: number): string {
  const delay = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delay).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExplicitlyNonRetryable(error: unknown): boolean {
  return error instanceof Error && "retryable" in error && (error as { retryable?: unknown }).retryable === false;
}
