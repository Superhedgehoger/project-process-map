import type { PrincipalId, TenantId } from "./identity.ts";

export type DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = Readonly<{
  tenantId: TenantId;
  eventId: string;
  projectId: string;
  projectSequence: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: number;
  actorPrincipalId: PrincipalId;
  occurredAtUtc: string;
  correlationId: string;
  causationId: string;
  originalSecurityDomainId: string | null;
  originalSecurityEpoch: number;
  payload: TPayload;
}>;

export type OutboxState = "pending" | "leased" | "published" | "dead_letter";
export type JobState = "pending" | "leased" | "completed" | "dead_letter";

export type OutboxMessage = Readonly<{
  tenantId: TenantId;
  id: string;
  eventId: string;
  topic: string;
  payload: DomainEvent;
  state: OutboxState;
  availableAtUtc: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAtUtc: string | null;
  lastError: string | null;
  publishedAtUtc: string | null;
  createdAtUtc: string;
}>;

export type BackgroundJob = Readonly<{
  tenantId: TenantId;
  id: string;
  jobType: string;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  state: JobState;
  priority: number;
  availableAtUtc: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAtUtc: string | null;
  lastError: string | null;
  completedAtUtc: string | null;
  createdAtUtc: string;
}>;

export function eventTopic(event: Pick<DomainEvent, "eventType" | "schemaVersion">): string {
  return `${event.eventType}.v${event.schemaVersion}`;
}
