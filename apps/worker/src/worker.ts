import { InMemoryTransactionalStore } from "../../../packages/domain/src/outbox.ts";

export function startWorker(
  workerStore: InMemoryTransactionalStore,
  intervalMilliseconds: number,
  log: (message: string) => void = console.log,
): { stop(): void } {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) throw new Error("Worker heartbeat must be positive");
  log(JSON.stringify({ component: "worker", status: "ready", outboxDepth: workerStore.snapshot().outbox.length }));
  const timer = setInterval(() => {
    log(JSON.stringify({
      component: "worker",
      status: "ok",
      checkedAt: new Date().toISOString(),
      outboxDepth: workerStore.snapshot().outbox.length,
    }));
  }, intervalMilliseconds);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
