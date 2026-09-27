import type {
  CompleteProjectNodeCommand,
  CompleteProjectNodeFailurePoint,
  CompleteProjectNodeResult,
  Persistence,
} from "./ports/persistence.ts";

export type {
  CompleteProjectNodeCommand,
  CompleteProjectNodeFailurePoint,
  CompleteProjectNodeResult,
  NodeCompletedPayload,
} from "./ports/persistence.ts";

export async function executeCompleteProjectNode(
  persistence: Persistence,
  command: CompleteProjectNodeCommand,
  failurePoint?: CompleteProjectNodeFailurePoint,
): Promise<CompleteProjectNodeResult> {
  return await persistence.executeCompleteProjectNode(command, failurePoint);
}

export class CompleteProjectNodeHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  execute(
    command: CompleteProjectNodeCommand,
    failurePoint?: CompleteProjectNodeFailurePoint,
  ): Promise<CompleteProjectNodeResult> {
    return executeCompleteProjectNode(this.#persistence, command, failurePoint);
  }
}

export function validateCompleteProjectNode(command: CompleteProjectNodeCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
  })) {
    if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  }
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new Error("occurredAtUtc must be a valid UTC timestamp");
  }
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion <= 0) {
    throw new Error("expectedVersion must be a positive integer");
  }
}
