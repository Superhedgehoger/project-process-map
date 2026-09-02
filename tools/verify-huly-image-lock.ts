import { readFile } from "node:fs/promises";

type ImageLock = {
  platform?: string;
  images?: Array<{ image?: string; platformDigest?: string }>;
};

const lock = JSON.parse(await readFile("infra/huly/image-lock.arm64.json", "utf8")) as ImageLock;
const override = await readFile("infra/huly/compose.digest.arm64.yml", "utf8");
const failures: string[] = [];

if (lock.platform !== "linux/arm64") failures.push("image lock platform must be linux/arm64");
if (lock.images?.length !== 14) failures.push("image lock must contain exactly 14 images");

const lockedDigests = new Set<string>();
for (const image of lock.images ?? []) {
  if (!image.image) failures.push("every lock entry needs its original image");
  if (!/^sha256:[0-9a-f]{64}$/.test(image.platformDigest ?? "")) {
    failures.push(`invalid platform digest for ${image.image ?? "unknown image"}`);
    continue;
  }
  lockedDigests.add(image.platformDigest as string);
}

const overrideDigests = new Set(
  [...override.matchAll(/@(?<digest>sha256:[0-9a-f]{64})/g)]
    .map((match) => match.groups?.digest)
    .filter((digest): digest is string => Boolean(digest)),
);

if (overrideDigests.size !== 14) failures.push("compose override must contain 14 unique digests");
for (const digest of lockedDigests) {
  if (!overrideDigests.has(digest)) failures.push(`compose override is missing ${digest}`);
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "blocked", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "ok", platform: lock.platform, images: lockedDigests.size }));
}
