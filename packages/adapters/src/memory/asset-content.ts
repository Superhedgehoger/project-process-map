import { createHash } from "node:crypto";
import { externalReferenceKey } from "../../../domain/src/external-reference.ts";
import type { AssetContentPort, PutAssetContent, StoredAssetContent } from "../../../application/src/ports/integrations.ts";

export class MemoryAssetContent implements AssetContentPort {
  readonly #content = new Map<string, StoredAssetContent & { bytes: Uint8Array }>();

  async put(input: PutAssetContent): Promise<StoredAssetContent> {
    verifyHash(input.bytes, input.sha256);
    const externalId = createHash("sha256").update(`${input.tenantId}\u0000${input.requestId}`).digest("hex");
    const reference = { provider: "memory", kind: "asset-content", externalId, schemaVersion: 1 } as const;
    const key = externalReferenceKey(reference);
    const previous = this.#content.get(key);
    if (previous !== undefined) {
      if (previous.sha256 !== input.sha256 || previous.contentType !== input.contentType) throw new Error("ASSET_CONTENT_REQUEST_CONFLICT");
      return publicRecord(previous);
    }
    const stored = {
      reference,
      contentType: input.contentType,
      size: input.bytes.byteLength,
      sha256: input.sha256,
      scanState: "available" as const,
      bytes: Uint8Array.from(input.bytes),
    };
    this.#content.set(key, stored);
    return publicRecord(stored);
  }

  async get(reference: StoredAssetContent["reference"]): Promise<StoredAssetContent | undefined> {
    const value = this.#content.get(externalReferenceKey(reference));
    return value === undefined ? undefined : publicRecord(value);
  }

  async remove(reference: StoredAssetContent["reference"]): Promise<void> {
    this.#content.delete(externalReferenceKey(reference));
  }
}

function verifyHash(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("ASSET_CONTENT_HASH_MISMATCH");
}

function publicRecord(value: StoredAssetContent & { bytes: Uint8Array }): StoredAssetContent {
  return {
    reference: structuredClone(value.reference),
    contentType: value.contentType,
    size: value.size,
    sha256: value.sha256,
    scanState: value.scanState,
  };
}

