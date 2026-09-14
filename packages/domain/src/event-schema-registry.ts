import type { DomainEvent } from "./events.ts";
import { nodeEventSchemas } from "./project-structure.ts";
import { projectMembershipRestrictionEventSchemas } from "./project-access.ts";

export type EventSchema = Readonly<{
  eventType: string;
  schemaVersion: number;
  requiredPayloadFields: readonly string[];
  optionalPayloadFields: readonly string[];
}>;

export const FORBIDDEN_SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "authheader",
  "authorization",
  "email",
  "phone",
  "phonenumber",
]);

const registeredSchemas = new Map<string, EventSchema>();

function registerSchema(schema: EventSchema): void {
  registeredSchemas.set(`${schema.eventType}:v${schema.schemaVersion}`, schema);
}

// Register known schemas
registerSchema(nodeEventSchemas.created);
registerSchema(nodeEventSchemas.leaderAssigned);
registerSchema(projectMembershipRestrictionEventSchemas.demoted);
registerSchema(projectMembershipRestrictionEventSchemas.revoked);

export function getEventSchema(eventType: string, schemaVersion: number): EventSchema | undefined {
  return registeredSchemas.get(`${eventType}:v${schemaVersion}`);
}

export function isRegisteredEventSchema(eventType: string, schemaVersion: number): boolean {
  return registeredSchemas.has(`${eventType}:v${schemaVersion}`);
}

export function assertNoSensitiveFields(value: unknown, path = ""): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoSensitiveFields(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (FORBIDDEN_SENSITIVE_KEYS.has(normalizedKey)) {
      throw new Error(`SENSITIVE_FIELD_FORBIDDEN:${key}`);
    }
    assertNoSensitiveFields(val, path ? `${path}.${key}` : key);
  }
}

export function validateEventAgainstSchema(event: DomainEvent): void {
  assertNoSensitiveFields(event);
  const schema = getEventSchema(event.eventType, event.schemaVersion);
  if (schema === undefined) {
    // If it's a node event or membership event with unknown version, or not recognized:
    if (
      event.eventType.startsWith("project-map.node.") ||
      event.eventType.startsWith("project-map.project-membership.")
    ) {
      throw new Error(`UNKNOWN_EVENT_SCHEMA_VERSION:${event.eventType}:v${event.schemaVersion}`);
    }
    return;
  }

  const payload = event.payload as Record<string, unknown>;
  for (const field of schema.requiredPayloadFields) {
    if (!(field in payload) || payload[field] === undefined) {
      throw new Error(`EVENT_PAYLOAD_MISSING_REQUIRED_FIELD:${field}`);
    }
  }

  const allowed = new Set([...schema.requiredPayloadFields, ...schema.optionalPayloadFields]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`EVENT_PAYLOAD_UNKNOWN_FIELD:${key}`);
    }
  }
}
