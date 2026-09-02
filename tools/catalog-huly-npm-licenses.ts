import { mkdir, readFile, writeFile } from "node:fs/promises";

type SbomComponent = { name?: string; version?: string; purl?: string };
type RegistryMetadata = {
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
  repository?: string | { url?: string };
};
type CatalogEntry = {
  name: string;
  version: string;
  license: string;
  registryUrl: string;
  repository?: string;
};

const sbom = JSON.parse(await readFile("artifacts/huly/sbom-platform.cdx.json", "utf8")) as {
  components?: SbomComponent[];
};
const packages = new Map<string, { name: string; version: string }>();
for (const component of sbom.components ?? []) {
  if (!component.purl?.startsWith("pkg:npm/") || !component.name || !component.version) continue;
  packages.set(`${component.name}@${component.version}`, { name: component.name, version: component.version });
}

const pending = [...packages.values()];
const entries: CatalogEntry[] = [];
const failures: Array<{ name: string; version: string; error: string }> = [];
let nextIndex = 0;
let completed = 0;

function declaredLicense(metadata: RegistryMetadata): string {
  if (typeof metadata.license === "string") return metadata.license;
  if (metadata.license?.type) return metadata.license.type;
  const legacy = metadata.licenses?.map((license) => license.type).filter(Boolean);
  return legacy?.length ? legacy.join(" OR ") : "UNKNOWN";
}

function repositoryUrl(metadata: RegistryMetadata): string | undefined {
  if (typeof metadata.repository === "string") return metadata.repository;
  return metadata.repository?.url;
}

async function fetchOne(pkg: { name: string; version: string }): Promise<void> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
  try {
    const response = await fetch(registryUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = (await response.json()) as RegistryMetadata;
    const repository = repositoryUrl(metadata);
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: declaredLicense(metadata),
      registryUrl,
      ...(repository ? { repository } : {}),
    });
  } catch (error) {
    failures.push({ name: pkg.name, version: pkg.version, error: error instanceof Error ? error.message : String(error) });
  } finally {
    completed += 1;
    if (completed % 250 === 0 || completed === pending.length) {
      console.log(JSON.stringify({ completed, total: pending.length, failures: failures.length }));
    }
  }
}

async function worker(): Promise<void> {
  while (nextIndex < pending.length) {
    const pkg = pending[nextIndex];
    nextIndex += 1;
    if (pkg) await fetchOne(pkg);
  }
}

await Promise.all(Array.from({ length: 32 }, () => worker()));
entries.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
failures.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const byLicense = Object.entries(
  entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.license] = (counts[entry.license] ?? 0) + 1;
    return counts;
  }, {}),
).sort((left, right) => right[1] - left[1]);

await mkdir("artifacts/huly", { recursive: true });
await writeFile(
  "artifacts/huly/npm-license-catalog.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), source: "npm registry", entries, failures, byLicense }, null, 2),
);
console.log(JSON.stringify({ status: failures.length ? "incomplete" : "ok", packages: entries.length, failures: failures.length, byLicense }));
