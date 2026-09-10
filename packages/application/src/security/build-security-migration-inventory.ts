import type { TenantId } from "../../../domain/src/identity.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import { ApplicationError } from "../errors.ts";
import type { Persistence, TransactionContext } from "../ports/persistence.ts";

export type SecurityMigrationInventoryQuery = Readonly<{
  tenantId: TenantId;
  projectId: string;
  rootNodeId: string;
  sourceSecurityDomainId: string | null;
  sourceSecurityEpoch: number;
}>;

export type SecurityMigrationInventoryItem = Readonly<{
  kind: "node" | "task" | "asset";
  id: string;
  rootNodeId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  securityEpoch: number;
  version: number;
  cursor: string;
}>;

export type SecurityMigrationInventory = Readonly<{
  rootNodeId: string;
  sourceSecurityDomainId: string | null;
  sourceSecurityEpoch: number;
  totalItems: number;
  items: readonly SecurityMigrationInventoryItem[];
}>;

export type SecurityMigrationInventoryProgress = Readonly<{
  cursor: string | null;
  migratedItems: number;
  targetSecurityDomainId: string | null;
  targetSecurityEpoch: number;
}>;

export class SecurityMigrationInventoryReader {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async build(query: SecurityMigrationInventoryQuery): Promise<SecurityMigrationInventory> {
    validate(query);
    try {
      return await this.#persistence.read(query.tenantId, async (transaction) => {
        const tenantNodes = await transaction.nodes.listForSecurityMigration();
        const tenantNodesById = new Map(tenantNodes.map((node) => [node.id, node]));
        assertProjectParentBoundary(tenantNodes, tenantNodesById, query.projectId);
        const projectNodes = tenantNodes.filter((node) => node.projectId === query.projectId);
        const nodesById = new Map(projectNodes.map((node) => [node.id, node]));
        const root = nodesById.get(query.rootNodeId);
        if (root === undefined) invalid();
        assertTreeIntegrity(projectNodes, nodesById);

        const subtreeIds = collectSubtree(root.id, projectNodes);
        const subtreeNodes = projectNodes.filter((node) => subtreeIds.has(node.id));
        for (const node of subtreeNodes) {
          assertSource(node, query);
          if (node.id !== root.id && await transaction.securityDomains.getByRoot(query.projectId, node.id) !== undefined) {
            invalid();
          }
        }

        const tasks = await transaction.tasks.listForSecurityMigration();
        const assets = await transaction.assets.listForSecurityMigration();
        for (const object of [...tasks, ...assets]) {
          const owner = nodesById.get(object.ownerNodeId);
          if ((object.projectId === query.projectId) !== (owner !== undefined)) invalid();
          if (owner !== undefined && object.projectId !== owner.projectId) invalid();
          if (subtreeIds.has(object.ownerNodeId)) assertSource(object, query);
        }

        const items = [
          ...subtreeNodes.map((node) => item("node", node.id, node.id, node, root.id)),
          ...tasks.filter((task) => subtreeIds.has(task.ownerNodeId))
            .map((task) => item("task", task.id, task.ownerNodeId, task, root.id)),
          ...assets.filter((asset) => subtreeIds.has(asset.ownerNodeId))
            .map((asset) => item("asset", asset.id, asset.ownerNodeId, asset, root.id)),
        ].sort(compareItems);
        return {
          rootNodeId: root.id,
          sourceSecurityDomainId: query.sourceSecurityDomainId,
          sourceSecurityEpoch: query.sourceSecurityEpoch,
          totalItems: items.length,
          items,
        };
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "SECURITY_MIGRATION_INVENTORY_INVALID") throw error;
      throw new ApplicationError("SECURITY_MIGRATION_INVENTORY_INVALID", "Security migration inventory is invalid");
    }
  }
}

export async function buildResumableSecurityMigrationInventory(
  transaction: TransactionContext,
  query: SecurityMigrationInventoryQuery,
  progress: SecurityMigrationInventoryProgress,
): Promise<SecurityMigrationInventory> {
  validate(query);
  try {
    if (!Number.isSafeInteger(progress.migratedItems) || progress.migratedItems < 0
      || !Number.isSafeInteger(progress.targetSecurityEpoch) || progress.targetSecurityEpoch <= 0) invalid();
    const tenantNodes = await transaction.nodes.listForSecurityMigration();
    const tenantNodesById = new Map(tenantNodes.map((node) => [node.id, node]));
    assertProjectParentBoundary(tenantNodes, tenantNodesById, query.projectId);
    const projectNodes = tenantNodes.filter((node) => node.projectId === query.projectId);
    const nodesById = new Map(projectNodes.map((node) => [node.id, node]));
    const root = nodesById.get(query.rootNodeId);
    if (root === undefined) invalid();
    assertTreeIntegrity(projectNodes, nodesById);

    const subtreeIds = collectSubtree(root.id, projectNodes);
    const subtreeNodes = projectNodes.filter((node) => subtreeIds.has(node.id));
    for (const node of subtreeNodes) {
      if (node.id !== root.id && await transaction.securityDomains.getByRoot(query.projectId, node.id) !== undefined) {
        invalid();
      }
    }

    const tasks = await transaction.tasks.listForSecurityMigration();
    const assets = await transaction.assets.listForSecurityMigration();
    for (const object of [...tasks, ...assets]) {
      const owner = nodesById.get(object.ownerNodeId);
      if ((object.projectId === query.projectId) !== (owner !== undefined)) invalid();
      if (owner !== undefined && object.projectId !== owner.projectId) invalid();
    }

    const items = [
      ...subtreeNodes.map((node) => item("node", node.id, node.id, node, root.id)),
      ...tasks.filter((task) => subtreeIds.has(task.ownerNodeId))
        .map((task) => item("task", task.id, task.ownerNodeId, task, root.id)),
      ...assets.filter((asset) => subtreeIds.has(asset.ownerNodeId))
        .map((asset) => item("asset", asset.id, asset.ownerNodeId, asset, root.id)),
    ].sort(compareItems);
    const completed = completedItemCount(items, progress);
    for (const [index, current] of items.entries()) {
      if (index < completed) assertTarget(current, progress);
      else assertSource(current, query);
    }
    return {
      rootNodeId: root.id,
      sourceSecurityDomainId: query.sourceSecurityDomainId,
      sourceSecurityEpoch: query.sourceSecurityEpoch,
      totalItems: items.length,
      items,
    };
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "SECURITY_MIGRATION_INVENTORY_INVALID") throw error;
    throw new ApplicationError("SECURITY_MIGRATION_INVENTORY_INVALID", "Security migration inventory is invalid");
  }
}

type SecurityOwned = Readonly<{
  securityDomainId: string | null;
  securityEpoch: number;
  version: number;
}>;

function validate(query: SecurityMigrationInventoryQuery): void {
  if (query.projectId.trim().length === 0 || query.rootNodeId.trim().length === 0
    || !Number.isSafeInteger(query.sourceSecurityEpoch) || query.sourceSecurityEpoch <= 0) invalid();
}

function assertProjectParentBoundary(
  nodes: readonly ProjectNode[],
  nodesById: ReadonlyMap<string, ProjectNode>,
  projectId: string,
): void {
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = nodesById.get(node.parentId);
    if (node.projectId === projectId && (parent === undefined || parent.projectId !== projectId)) invalid();
    if (parent?.projectId === projectId && node.projectId !== projectId) invalid();
  }
}

function assertTreeIntegrity(nodes: readonly ProjectNode[], nodesById: ReadonlyMap<string, ProjectNode>): void {
  for (const node of nodes) if (node.parentId !== null && !nodesById.has(node.parentId)) invalid();
  const complete = new Set<string>();
  for (const node of nodes) {
    const visiting = new Set<string>();
    let current: ProjectNode | undefined = node;
    while (current !== undefined && !complete.has(current.id)) {
      if (visiting.has(current.id)) invalid();
      visiting.add(current.id);
      current = current.parentId === null ? undefined : nodesById.get(current.parentId);
    }
    for (const id of visiting) complete.add(id);
  }
}

function collectSubtree(rootNodeId: string, nodes: readonly ProjectNode[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const selected = new Set<string>();
  const pending = [rootNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop() as string;
    if (selected.has(nodeId)) invalid();
    selected.add(nodeId);
    pending.push(...(children.get(nodeId) ?? []));
  }
  return selected;
}

function assertSource(value: SecurityOwned, query: SecurityMigrationInventoryQuery): void {
  if (value.securityDomainId !== query.sourceSecurityDomainId || value.securityEpoch !== query.sourceSecurityEpoch) invalid();
}

function assertTarget(value: SecurityOwned, progress: SecurityMigrationInventoryProgress): void {
  if (value.securityDomainId !== progress.targetSecurityDomainId || value.securityEpoch !== progress.targetSecurityEpoch) invalid();
}

function completedItemCount(
  items: readonly SecurityMigrationInventoryItem[],
  progress: SecurityMigrationInventoryProgress,
): number {
  if (progress.cursor === null) {
    if (progress.migratedItems !== 0) invalid();
    return 0;
  }
  const cursorIndex = items.findIndex((current) => current.cursor === progress.cursor);
  if (cursorIndex < 0 || cursorIndex + 1 !== progress.migratedItems) invalid();
  return cursorIndex + 1;
}

function item(
  kind: SecurityMigrationInventoryItem["kind"],
  id: string,
  ownerNodeId: string,
  value: SecurityOwned,
  rootNodeId: string,
): SecurityMigrationInventoryItem {
  return {
    kind,
    id,
    rootNodeId,
    ownerNodeId,
    securityDomainId: value.securityDomainId,
    securityEpoch: value.securityEpoch,
    version: value.version,
    cursor: JSON.stringify([ownerNodeId, kind, id]),
  };
}

function compareItems(left: SecurityMigrationInventoryItem, right: SecurityMigrationInventoryItem): number {
  return compareText(left.ownerNodeId, right.ownerNodeId)
    || kindRank(left.kind) - kindRank(right.kind)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function kindRank(kind: SecurityMigrationInventoryItem["kind"]): number {
  return kind === "node" ? 0 : kind === "task" ? 1 : 2;
}

function invalid(): never {
  throw new ApplicationError("SECURITY_MIGRATION_INVENTORY_INVALID", "Security migration inventory is invalid");
}
