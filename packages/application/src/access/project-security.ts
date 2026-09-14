import { ApplicationError } from "../errors.ts";
import type { TransactionContext } from "../ports/persistence.ts";
import type { PrincipalId } from "../../../domain/src/identity.ts";
import type { ProjectMembership } from "../../../domain/src/project-access.ts";
import { isNodeLeader, type ProjectNode } from "../../../domain/src/project-structure.ts";
import type { SecurityDomainMigration } from "../../../domain/src/security-migration.ts";
import { grantAllows, type SecurityCapability } from "../../../domain/src/security-access.ts";

export async function canAccessProjectObject(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  projectId: string,
  securityDomainId: string | null,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  if (membership?.status !== "active" || membership.projectId !== projectId) return false;
  if (securityDomainId === null) return true;
  const domain = await transaction.securityDomains.get(securityDomainId);
  if (domain === undefined) {
    // v3 stored visibility only. It must never be promoted into a write or access-management capability.
    return requiredCapability === "view" && membership.securityDomainIds.includes(securityDomainId);
  }
  if (domain.projectId !== projectId || domain.deletedAtUtc !== null) return false;
  if (requiredCapability === "manage_access" && membership.role !== "project_manager") return false;
  // Nested-domain intersection is deliberately fail-closed until TC-SEC-002.
  if (domain.parentSecurityDomainId !== null) return false;
  return grantAllows(await transaction.securityGrants.get(domain.id, principalId), requiredCapability, atUtc);
}

export type SecurityOwnedObjectReference = Readonly<{
  projectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  securityEpoch: number;
}>;

export async function canAccessProjectObjectDuringMigration(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  object: SecurityOwnedObjectReference,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  const principal = await transaction.principals.get(principalId);
  if (principal?.status !== "active") return false;

  const ownerNode = await transaction.nodes.get(object.ownerNodeId);
  if (ownerNode === undefined || ownerNode.deletedAtUtc !== null) return false;
  if (ownerNode.projectId !== object.projectId) return false;
  if (ownerNode.securityDomainId !== object.securityDomainId || ownerNode.securityEpoch !== object.securityEpoch) return false;

  if (ownerNode.leaderPrincipalId !== null && (requiredCapability === "edit" || requiredCapability === "contribute")) {
    const isManager = membership?.role === "project_manager";
    const isLeader = isNodeLeader(ownerNode, principalId);
    if (!isManager && !isLeader) return false;
  }

  const migrations = (await transaction.securityMigrations.listRecoverable())
    .filter((migration) => migration.projectId === object.projectId && dualDomainState(migration));
  const relevant: SecurityDomainMigration[] = [];
  for (const migration of migrations) {
    const root = await transaction.nodes.get(migration.rootNodeId);
    if (root === undefined || root.projectId !== object.projectId || root.deletedAtUtc !== null) return false;
    const scope = await migrationScope(transaction, object.projectId, object.ownerNodeId, root.id);
    if (scope === "invalid") return false;
    if (scope === "inside") relevant.push(migration);
  }
  if (relevant.length === 0) return await canAccessProjectObject(
    transaction, membership, principalId, object.projectId, object.securityDomainId, requiredCapability, atUtc,
  );
  if (relevant.length !== 1) return false;
  const migration = relevant[0] as SecurityDomainMigration;
  const isSource = object.securityDomainId === migration.sourceSecurityDomainId
    && object.securityEpoch === migration.sourceSecurityEpoch;
  const isTarget = object.securityDomainId === migration.targetSecurityDomainId
    && object.securityEpoch === migration.targetSecurityEpoch;
  if (!isSource && !isTarget) return false;
  if (!await canAccessMigrationEndpoint(
    transaction, membership, principalId, object.projectId, migration.sourceSecurityDomainId, requiredCapability, atUtc,
  )) return false;
  if (migration.sourceSecurityDomainId === migration.targetSecurityDomainId) return true;
  return await canAccessMigrationEndpoint(
    transaction, membership, principalId, object.projectId, migration.targetSecurityDomainId, requiredCapability, atUtc,
  );
}

export async function canViewProjectObjectDuringMigration(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  object: SecurityOwnedObjectReference,
  atUtc: string,
): Promise<boolean> {
  return await canAccessProjectObjectDuringMigration(
    transaction, membership, principalId, object, "view", atUtc,
  );
}

export async function canAccessProjectNode(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  nodeOrId: ProjectNode | string,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  const principal = await transaction.principals.get(principalId);
  if (principal?.status !== "active" || principal.kind !== "user") return false;

  const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId.id;
  const node = await transaction.nodes.get(nodeId);
  if (node === undefined || node.deletedAtUtc !== null) return false;
  if (typeof nodeOrId === "object") {
    if (
      nodeOrId.projectId !== node.projectId ||
      nodeOrId.securityDomainId !== node.securityDomainId ||
      nodeOrId.securityEpoch !== node.securityEpoch ||
      nodeOrId.leaderPrincipalId !== node.leaderPrincipalId ||
      nodeOrId.version !== node.version ||
      nodeOrId.deletedAtUtc !== node.deletedAtUtc
    ) {
      return false;
    }
  }

  if (membership?.status !== "active" || membership.projectId !== node.projectId) return false;

  if (requiredCapability === "manage_access") {
    if (membership.role !== "project_manager") return false;
  } else if (requiredCapability === "edit") {
    const isManager = membership.role === "project_manager";
    const isLeader = isNodeLeader(node, principalId);
    if (!isManager && !isLeader) return false;
  } else if (requiredCapability === "contribute") {
    if (node.leaderPrincipalId !== null) {
      const isManager = membership.role === "project_manager";
      const isLeader = isNodeLeader(node, principalId);
      if (!isManager && !isLeader) return false;
    }
  }

  if (node.securityDomainId === null) return true;
  return await canAccessProjectObject(
    transaction,
    membership,
    principalId,
    node.projectId,
    node.securityDomainId,
    requiredCapability,
    atUtc,
  );
}

export async function canAccessProjectNodeDuringMigration(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  nodeOrId: ProjectNode | string,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  const principal = await transaction.principals.get(principalId);
  if (principal?.status !== "active" || principal.kind !== "user") return false;

  const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId.id;
  const node = await transaction.nodes.get(nodeId);
  if (node === undefined || node.deletedAtUtc !== null) return false;
  if (typeof nodeOrId === "object") {
    if (
      nodeOrId.projectId !== node.projectId ||
      nodeOrId.securityDomainId !== node.securityDomainId ||
      nodeOrId.securityEpoch !== node.securityEpoch ||
      nodeOrId.leaderPrincipalId !== node.leaderPrincipalId ||
      nodeOrId.version !== node.version ||
      nodeOrId.deletedAtUtc !== node.deletedAtUtc
    ) {
      return false;
    }
  }

  if (membership?.status !== "active" || membership.projectId !== node.projectId) return false;

  if (requiredCapability === "manage_access") {
    if (membership.role !== "project_manager") return false;
  } else if (requiredCapability === "edit") {
    const isManager = membership.role === "project_manager";
    const isLeader = isNodeLeader(node, principalId);
    if (!isManager && !isLeader) return false;
  } else if (requiredCapability === "contribute") {
    if (node.leaderPrincipalId !== null) {
      const isManager = membership.role === "project_manager";
      const isLeader = isNodeLeader(node, principalId);
      if (!isManager && !isLeader) return false;
    }
  }

  return await canAccessProjectObjectDuringMigration(
    transaction,
    membership,
    principalId,
    {
      projectId: node.projectId,
      ownerNodeId: node.id,
      securityDomainId: node.securityDomainId,
      securityEpoch: node.securityEpoch,
    },
    requiredCapability,
    atUtc,
  );
}

function dualDomainState(migration: SecurityDomainMigration): boolean {
  return ["active", "verifying", "retryable", "recovery_required"].includes(migration.state);
}

async function canAccessMigrationEndpoint(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  projectId: string,
  securityDomainId: string | null,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  if (securityDomainId !== null) {
    const domain = await transaction.securityDomains.get(securityDomainId);
    if (domain === undefined || domain.projectId !== projectId || domain.deletedAtUtc !== null
      || domain.parentSecurityDomainId !== null) return false;
  }
  return await canAccessProjectObject(
    transaction, membership, principalId, projectId, securityDomainId, requiredCapability, atUtc,
  );
}

async function migrationScope(
  transaction: TransactionContext,
  projectId: string,
  ownerNodeId: string,
  rootNodeId: string,
): Promise<"inside" | "outside" | "invalid"> {
  const visited = new Set<string>();
  let currentId: string | null = ownerNodeId;
  while (currentId !== null) {
    if (visited.has(currentId)) return "invalid";
    visited.add(currentId);
    const current = await transaction.nodes.get(currentId);
    if (current === undefined || current.projectId !== projectId) return "invalid";
    if (current.id === rootNodeId) return "inside";
    currentId = current.parentId;
  }
  return "outside";
}

/**
 * P0-07 will apply source/target domain intersections per object. Until then,
 * fail closed for the entire project so a partial migration cannot expose data.
 */
export async function assertProjectSecurityStable(
  transaction: TransactionContext,
  projectId: string,
): Promise<void> {
  const open = (await transaction.securityMigrations.listRecoverable())
    .some((migration) => migration.projectId === projectId);
  if (open) throw new ApplicationError(
    "SECURITY_MIGRATION_IN_PROGRESS",
    "Project access is temporarily frozen during a security-domain migration",
  );
}
