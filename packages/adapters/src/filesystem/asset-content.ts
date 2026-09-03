import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { externalReferenceKey, type ExternalReference } from "../../../domain/src/external-reference.ts";
import type { AssetContentPort, PutAssetContent, StoredAssetContent } from "../../../application/src/ports/integrations.ts";

type Metadata = Omit<StoredAssetContent, "reference">;

export class FilesystemAssetContent implements AssetContentPort {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) throw new Error("Asset content directory is required");
    this.rootDirectory = rootDirectory;
  }

  async put(input: PutAssetContent): Promise<StoredAssetContent> {
    verifyHash(input.bytes, input.sha256);
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const externalId = createHash("sha256").update(`${input.tenantId}\u0000${input.requestId}`).digest("hex");
    const reference = { provider: "local-fs", kind: "asset-content", externalId, schemaVersion: 1 } as const;
    const previous = await this.get(reference);
    if (previous !== undefined) {
      if (previous.sha256 !== input.sha256 || previous.contentType !== input.contentType || previous.size !== input.bytes.byteLength) {
        throw new Error("ASSET_CONTENT_REQUEST_CONFLICT");
      }
      return previous;
    }
    const blobPath = this.blobPath(reference);
    const metadataPath = this.metadataPath(reference);
    const metadata: Metadata = {
      contentType: input.contentType,
      size: input.bytes.byteLength,
      sha256: input.sha256,
      scanState: "available",
    };
    try {
      await writeFile(blobPath, input.bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existingBytes = await readFile(blobPath);
      verifyHash(existingBytes, input.sha256);
    }
    try {
      await writeFile(metadataPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const previousMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
      if (JSON.stringify(previousMetadata) !== JSON.stringify(metadata)) throw new Error("ASSET_CONTENT_REQUEST_CONFLICT");
    }
    return { reference, ...metadata };
  }

  async get(reference: ExternalReference): Promise<StoredAssetContent | undefined> {
    this.assertReference(reference);
    try {
      const metadata = JSON.parse(await readFile(this.metadataPath(reference), "utf8")) as Metadata;
      const bytes = await readFile(this.blobPath(reference));
      verifyHash(bytes, metadata.sha256);
      if (bytes.byteLength !== metadata.size) throw new Error("ASSET_CONTENT_SIZE_MISMATCH");
      return { reference, ...metadata };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async remove(reference: ExternalReference): Promise<void> {
    this.assertReference(reference);
    await Promise.allSettled([unlink(this.blobPath(reference)), unlink(this.metadataPath(reference))]);
  }

  private blobPath(reference: ExternalReference): string {
    return join(this.rootDirectory, `${reference.externalId}.blob`);
  }

  private metadataPath(reference: ExternalReference): string {
    return join(this.rootDirectory, `${reference.externalId}.json`);
  }

  private assertReference(reference: ExternalReference): void {
    if (reference.provider !== "local-fs" || reference.kind !== "asset-content" || reference.schemaVersion !== 1) {
      throw new Error(`ASSET_CONTENT_REFERENCE_INVALID:${externalReferenceKey(reference)}`);
    }
    if (!/^[a-f0-9]{64}$/.test(reference.externalId)) throw new Error("ASSET_CONTENT_EXTERNAL_ID_INVALID");
  }
}

function verifyHash(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("ASSET_CONTENT_HASH_MISMATCH");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
