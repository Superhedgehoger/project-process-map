import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type ImageLock = {
  platform?: string;
  images?: Array<{ image?: string; platformDigest?: string }>;
};

type CycloneDx = {
  components?: Array<{ name?: string; version?: string; purl?: string; licenses?: unknown[] }>;
};

type ImageResult = {
  image: string;
  platformDigest: string;
  sbomPath: string;
  sha256: string;
  components: number;
  componentsWithLicenseMetadata: number;
};

const syft = process.env.SYFT_BIN ?? "syft";
const reuseExisting = process.env.HULY_IMAGE_SBOM_REUSE === "true";
const outputDirectory = "artifacts/huly/image-sboms";
const lock = JSON.parse(await readFile("infra/huly/image-lock.arm64.json", "utf8")) as ImageLock;

if (lock.platform !== "linux/arm64" || lock.images?.length !== 14) {
  throw new Error("expected the verified 14-image linux/arm64 lock");
}

function repository(image: string): string {
  return image.replace(/:[^/]+$/, "");
}

function filename(image: string): string {
  return image.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/-+$/g, "");
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: "false" },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown"}`)));
  });
}

await mkdir(outputDirectory, { recursive: true });
const results: ImageResult[] = [];
const uniqueComponents = new Set<string>();
const uniqueNpmComponents = new Set<string>();
const uniqueOsComponents = new Set<string>();
const uniqueComponentsWithLicenseMetadata = new Set<string>();

for (const [index, entry] of lock.images.entries()) {
  if (!entry.image || !entry.platformDigest) throw new Error(`invalid image lock entry ${index}`);
  const sbomPath = `${outputDirectory}/${filename(entry.image)}.cdx.json`;
  const source = `docker:${repository(entry.image)}@${entry.platformDigest}`;
  console.log(JSON.stringify({ status: reuseExisting ? "reading" : "scanning", current: index + 1, total: lock.images.length, image: entry.image }));
  if (!reuseExisting) await run(syft, [source, "-o", `cyclonedx-json=${sbomPath}`]);

  const contents = await readFile(sbomPath);
  const sbom = JSON.parse(contents.toString("utf8")) as CycloneDx;
  const components = sbom.components ?? [];
  for (const component of components) {
    const key = component.purl ?? `${component.name ?? "unknown"}@${component.version ?? "unknown"}`;
    uniqueComponents.add(key);
    if (component.purl?.startsWith("pkg:npm/")) uniqueNpmComponents.add(key);
    if (/^pkg:(?:deb|rpm|apk)\//.test(component.purl ?? "")) uniqueOsComponents.add(key);
    if ((component.licenses?.length ?? 0) > 0) uniqueComponentsWithLicenseMetadata.add(key);
  }
  results.push({
    image: entry.image,
    platformDigest: entry.platformDigest,
    sbomPath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    components: components.length,
    componentsWithLicenseMetadata: components.filter((component) => (component.licenses?.length ?? 0) > 0).length,
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  tool: "Syft",
  platform: lock.platform,
  images: results,
  totals: {
    images: results.length,
    components: results.reduce((sum, result) => sum + result.components, 0),
    componentsWithLicenseMetadata: results.reduce((sum, result) => sum + result.componentsWithLicenseMetadata, 0),
    uniqueComponents: uniqueComponents.size,
    uniqueNpmComponents: uniqueNpmComponents.size,
    uniqueOsComponents: uniqueOsComponents.size,
    uniqueComponentsWithLicenseMetadata: uniqueComponentsWithLicenseMetadata.size,
  },
};

await writeFile("artifacts/huly/image-sbom-summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: "ok", ...summary.totals }));
