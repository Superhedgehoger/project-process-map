import { ApplicationError } from "../../application/src/errors.ts";
import type { TenantId } from "../../domain/src/identity.ts";
import type {
  EpochReadinessScope,
  ExternalCollaborationEpochReadinessPort,
  SecurityMigrationReadinessEvidence,
} from "../../application/src/ports/integrations.ts";
import type {
  Persistence,
  SecurityMigrationReadinessEvidenceRecord,
} from "../../application/src/ports/persistence.ts";
import type {
  VerifyMigrationReadiness,
  VerifyMigrationReadinessInput,
  VerifyMigrationReadinessResult,
} from "../../application/src/security/security-migration-coordinator.ts";
import { validateCanonicalSnapshotItems } from "../../application/src/security/security-migration-manifest.ts";

export type InternalIssueChallengeParams = Readonly<{
  migrationId: string;
  purpose: "commit" | "rollback";
  ttlMilliseconds?: number | undefined;
}>;

export type TestReadinessHarness = Readonly<{
  issueChallenge: (tenantId: TenantId, params: InternalIssueChallengeParams) => Promise<SecurityMigrationReadinessEvidenceRecord>;
  recordVerifiedEvidence: (tenantId: TenantId, params: InternalRecordVerifiedEvidenceParams) => Promise<SecurityMigrationReadinessEvidenceRecord>;
  createVerificationOperation: (verifier?: ExternalCollaborationEpochReadinessPort | undefined) => VerifyMigrationReadiness;
}>;

export type InternalRecordVerifiedEvidenceParams = Readonly<{
  evidenceId: string;
  nonce: string;
  tenantId: TenantId;
  projectId: string;
  migrationId: string;
  purpose: "commit" | "rollback";
  sourceSecurityDomainId: string | null;
  targetSecurityDomainId: string | null;
  sourceSecurityEpoch: number;
  targetSecurityEpoch: number;
  manifestDigest: string;
  itemCount: number;
  provider: string;
  converged: boolean;
  issuedAtUtc: string;
  expiresAtUtc: string;
  channels: Readonly<{
    issue: "converged" | "not_converged";
    attachment: "converged" | "not_converged";
    blob: "converged" | "not_converged";
  }>;
  reason?: string | null | undefined;
}>;

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

export function createVerificationOperation(options: {
  persistence: Persistence;
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  issueChallenge: (tenantId: TenantId, params: InternalIssueChallengeParams) => Promise<SecurityMigrationReadinessEvidenceRecord>;
  recordVerifiedEvidence: (tenantId: TenantId, params: InternalRecordVerifiedEvidenceParams) => Promise<SecurityMigrationReadinessEvidenceRecord>;
  nowUtc: () => string;
}): VerifyMigrationReadiness {
  const { persistence, verifier, issueChallenge, recordVerifiedEvidence, nowUtc } = options;

  return async (input: VerifyMigrationReadinessInput): Promise<VerifyMigrationReadinessResult> => {
    if (verifier === undefined) {
      throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Collaboration epoch readiness adapter is not configured");
    }

    const challenge = await issueChallenge(input.tenantId, {
      migrationId: input.migrationId,
      purpose: input.purpose,
    });

    const snapshot = await persistence.read(input.tenantId, async (tx) => {
      return await tx.securityMigrations.getManifestSnapshot(input.migrationId);
    });
    if (snapshot === undefined) {
      throw new ApplicationError("SECURITY_MIGRATION_MANIFEST_MISMATCH", "Manifest snapshot not found");
    }

    validateCanonicalSnapshotItems(snapshot, {
      tenantId: input.tenantId,
      projectId: challenge.projectId,
      migrationId: input.migrationId,
      sourceSecurityDomainId: input.purpose === "rollback" ? challenge.targetSecurityDomainId : challenge.sourceSecurityDomainId,
      targetSecurityDomainId: input.purpose === "rollback" ? challenge.sourceSecurityDomainId : challenge.targetSecurityDomainId,
      sourceSecurityEpoch: input.purpose === "rollback" ? challenge.targetSecurityEpoch : challenge.sourceSecurityEpoch,
      targetSecurityEpoch: input.purpose === "rollback" ? challenge.sourceSecurityEpoch : challenge.targetSecurityEpoch,
    });

    const taskItems = snapshot.items.filter((item) => item.kind === "task");
    const assetItems = snapshot.items.filter((item) => item.kind === "asset");

    const scope: EpochReadinessScope = {
      tenantId: input.tenantId,
      projectId: challenge.projectId,
      migrationId: challenge.migrationId,
      evidenceId: challenge.evidenceId,
      purpose: input.purpose,
      manifestDigest: challenge.manifestDigest,
      sourceSecurityDomainId: challenge.sourceSecurityDomainId,
      targetSecurityDomainId: challenge.targetSecurityDomainId,
      sourceSecurityEpoch: challenge.sourceSecurityEpoch,
      targetSecurityEpoch: challenge.targetSecurityEpoch,
      nonce: challenge.nonce,
      issuedAtUtc: challenge.issuedAtUtc,
      expiresAtUtc: challenge.expiresAtUtc,
      itemCount: challenge.itemCount,
      tasks: taskItems.map((t) => ({
        taskId: t.id,
        externalReference: t.externalReference ?? null,
      })),
      assets: assetItems.map((a) => ({
        assetId: a.id,
        externalIssueId: a.externalIssueId ?? null,
        externalAttachmentReference: a.externalAttachmentReference ?? null,
        externalBlobReference: a.externalBlobReference ?? null,
      })),
    };

    let evidence: SecurityMigrationReadinessEvidence;
    try {
      evidence = await verifier.checkEpochReadiness(scope);
    } catch (error) {
      throw new ApplicationError(
        "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `External collaboration epoch readiness check threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (evidence.provider !== "huly") {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", 'Allowlisted provider is strictly "huly"');
    }

    if (evidence.purpose !== challenge.purpose) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Evidence purpose does not match challenge purpose");
    }

    if (
      evidence.evidenceId !== challenge.evidenceId
      || evidence.nonce !== challenge.nonce
      || evidence.tenantId !== challenge.tenantId
      || evidence.projectId !== challenge.projectId
      || evidence.migrationId !== challenge.migrationId
      || evidence.manifestDigest !== challenge.manifestDigest
      || evidence.itemCount !== challenge.itemCount
      || evidence.sourceSecurityDomainId !== challenge.sourceSecurityDomainId
      || evidence.targetSecurityDomainId !== challenge.targetSecurityDomainId
      || evidence.sourceSecurityEpoch !== challenge.sourceSecurityEpoch
      || evidence.targetSecurityEpoch !== challenge.targetSecurityEpoch
      || evidence.expiresAtUtc !== challenge.expiresAtUtc
    ) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Verifier response does not match issued challenge binding");
    }

    if (evidence.consumedAtUtc !== null) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Evidence is already consumed");
    }

    if (challenge.status !== "issued") {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_ALREADY_VERIFIED", "Challenge is already verified or consumed");
    }

    const currentNowUtc = nowUtc();
    if (!isIsoTimestamp(evidence.verifiedAtUtc)) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Verifier timestamp is invalid");
    }
    if (evidence.verifiedAtUtc > currentNowUtc) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Future verifier timestamp rejected");
    }
    if (evidence.verifiedAtUtc < challenge.issuedAtUtc) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_INVALID", "Verifier timestamp predates challenge issuance");
    }
    if (currentNowUtc > challenge.expiresAtUtc) {
      throw new ApplicationError("SECURITY_MIGRATION_EVIDENCE_EXPIRED", "Readiness challenge expired");
    }

    let certified: SecurityMigrationReadinessEvidenceRecord;
    try {
      certified = await recordVerifiedEvidence(input.tenantId, {
        evidenceId: challenge.evidenceId,
        nonce: challenge.nonce,
        tenantId: challenge.tenantId,
        projectId: challenge.projectId,
        migrationId: challenge.migrationId,
        purpose: challenge.purpose,
        sourceSecurityDomainId: challenge.sourceSecurityDomainId,
        targetSecurityDomainId: challenge.targetSecurityDomainId,
        sourceSecurityEpoch: challenge.sourceSecurityEpoch,
        targetSecurityEpoch: challenge.targetSecurityEpoch,
        manifestDigest: challenge.manifestDigest,
        itemCount: challenge.itemCount,
        issuedAtUtc: challenge.issuedAtUtc,
        expiresAtUtc: challenge.expiresAtUtc,
        provider: evidence.provider,
        converged: evidence.converged,
        channels: evidence.channels,
        reason: evidence.reason,
      });
    } catch (err) {
      if (err instanceof ApplicationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApplicationError(msg as any, msg);
    }

    if (
      !evidence.converged
      || evidence.channels.issue !== "converged"
      || evidence.channels.attachment !== "converged"
      || evidence.channels.blob !== "converged"
    ) {
      throw new ApplicationError(
        "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `External collaboration epoch readiness not converged: ${evidence.reason ?? "channels or epoch mismatch"}`,
      );
    }

    return {
      evidenceId: certified.evidenceId,
      record: certified,
    };
  };
}
