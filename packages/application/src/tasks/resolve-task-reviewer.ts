import { assertValidSlotKey, compareExactStrings } from "../../../domain/src/role-slots.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type { TransactionContext } from "../ports/persistence.ts";
import { canAccessProjectObject } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";

export type ResolveTaskReviewerParams = Readonly<{
  tenantId: TenantId;
  projectId: string;
  node: ProjectNode;
  explicitReviewerPrincipalId?: PrincipalId | null | undefined;
  reviewerRoleSlotKey?: string | null | undefined;
  authorizationAtUtc: string;
}>;

export type ResolvedReviewer = Readonly<{
  reviewerPrincipalId: PrincipalId;
  source: "explicit" | "role_slot" | "node_owner";
}>;

export async function isCandidateEligible(
  transaction: TransactionContext,
  tenantId: TenantId,
  projectId: string,
  securityDomainId: string | null,
  candidatePrincipalId: PrincipalId,
  authorizationAtUtc: string,
): Promise<boolean> {
  const principal = await transaction.principals.get(candidatePrincipalId);
  if (
    principal === undefined ||
    principal.tenantId !== tenantId ||
    principal.status !== "active" ||
    principal.kind !== "user"
  ) {
    return false;
  }

  const membership = await transaction.memberships.get(projectId, candidatePrincipalId);
  if (
    membership === undefined ||
    membership.tenantId !== tenantId ||
    membership.projectId !== projectId ||
    membership.status !== "active"
  ) {
    return false;
  }

  return await canAccessProjectObject(
    transaction,
    membership,
    candidatePrincipalId,
    projectId,
    securityDomainId,
    "view",
    authorizationAtUtc,
  );
}

export async function resolveTaskReviewer(
  transaction: TransactionContext,
  params: ResolveTaskReviewerParams,
): Promise<ResolvedReviewer> {
  const {
    tenantId,
    projectId,
    node,
    explicitReviewerPrincipalId,
    reviewerRoleSlotKey,
    authorizationAtUtc,
  } = params;

  // Level 1: Eligible explicit reviewer wins.
  // If explicit reviewer is supplied but ineligible, reject with REVIEWER_NOT_ELIGIBLE.
  if (explicitReviewerPrincipalId !== null && explicitReviewerPrincipalId !== undefined) {
    const isEligible = await isCandidateEligible(
      transaction,
      tenantId,
      projectId,
      node.securityDomainId,
      explicitReviewerPrincipalId,
      authorizationAtUtc,
    );
    if (!isEligible) {
      throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The reviewer is not eligible for this task");
    }
    return {
      reviewerPrincipalId: explicitReviewerPrincipalId,
      source: "explicit",
    };
  }

  // Level 2: Project template role slot.
  // Only when explicit reviewer is null does reviewerRoleSlotKey participate.
  if (reviewerRoleSlotKey !== null && reviewerRoleSlotKey !== undefined) {
    if (typeof reviewerRoleSlotKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(reviewerRoleSlotKey)) {
      throw new ApplicationError("VALIDATION_FAILED", `reviewerRoleSlotKey format or length is invalid: ${reviewerRoleSlotKey}`);
    }
    const slot = await transaction.roleSlots.get(projectId, reviewerRoleSlotKey);
    if (slot !== undefined) {
      const binding = await transaction.roleBindings.get(projectId, reviewerRoleSlotKey);
      if (binding !== undefined && binding.principalIds.length > 0) {
        const eligibleCandidates: PrincipalId[] = [];
        for (const candidateId of binding.principalIds) {
          if (await isCandidateEligible(transaction, tenantId, projectId, node.securityDomainId, candidateId, authorizationAtUtc)) {
            eligibleCandidates.push(candidateId);
          }
        }
        if (eligibleCandidates.length > 0) {
          eligibleCandidates.sort(compareExactStrings);
          return {
            reviewerPrincipalId: eligibleCandidates[0]!,
            source: "role_slot",
          };
        }
      }
    }
    // Slot missing, unbound, or every bound candidate currently ineligible -> fall through to node leader
  }

  // Level 3: Current owner Node leader.
  if (node.leaderPrincipalId !== null && node.leaderPrincipalId !== undefined) {
    const isEligible = await isCandidateEligible(
      transaction,
      tenantId,
      projectId,
      node.securityDomainId,
      node.leaderPrincipalId,
      authorizationAtUtc,
    );
    if (isEligible) {
      return {
        reviewerPrincipalId: node.leaderPrincipalId,
        source: "node_owner",
      };
    }
  }

  // Level 4: Final fallback -> REVIEWER_REQUIRED
  throw new ApplicationError("REVIEWER_REQUIRED", "A reviewer is required for an acceptance task");
}
