import path from "node:path";
import { promises as fs } from "node:fs";
import type { DiscoveryItem } from "@/lib/content-discovery";

const VAULT_ROOT = path.join(process.cwd(), "public", "memes-content");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const ALLOWED_CATEGORIES = ["kapwing_video", "9gag_humor", "9gag_lifestyle", "9gag_motorvehicles", "9gag_music", "9gag_wtf"];
const ITEMS_PER_CATEGORY_TURN = 2;
const IMAGE_EVERY_N_PICKS = 4;

interface VaultFile {
  id: string;
  category: string;
  source: string;
  mediaType: "image" | "video";
  filename: string;
  localMediaPath: string;
  contextText: string | null;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function createVaultItemId(category: string, filename: string): string {
  return Buffer.from(`${category}\u0000${filename}`, "utf8").toString("base64url");
}

function sourceForCategory(category: string): string {
  if (category.startsWith("9gag_")) return "9gag";
  if (category.startsWith("kapwing_")) return "kapwing";
  return "funny";
}

function deriveContextText(filename: string): string | null {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const match = withoutExtension.match(/^(.*)_[a-zA-Z0-9]{6,}$/);
  const context = (match?.[1] ?? withoutExtension).replace(/[-_]+/g, " ").trim();
  return context || null;
}

function tagsForFile(file: VaultFile): string[] {
  const contextTags = (file.contextText ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tag) => tag.length >= 3)
    .slice(0, 8);
  return Array.from(new Set(["meme", file.category, file.source, ...contextTags]));
}

async function readLocalVaultFiles(categories?: string[]): Promise<VaultFile[]> {
  let directories: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    directories = await fs.readdir(VAULT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: VaultFile[] = [];
  for (const entry of directories) {
    if (!entry.isDirectory() || !entry.name.startsWith("downloads_")) continue;
    const category = entry.name.replace(/^downloads_/, "");
    if (categories && !categories.includes(category)) continue;

    const directory = path.join(VAULT_ROOT, entry.name);
    for (const filename of await fs.readdir(directory)) {
      const extension = path.extname(filename).toLowerCase();
      const mediaType = VIDEO_EXTENSIONS.has(extension) ? "video" : IMAGE_EXTENSIONS.has(extension) ? "image" : null;
      if (!mediaType) continue;
      files.push({
        id: createVaultItemId(category, filename),
        category,
        source: sourceForCategory(category),
        mediaType,
        filename,
        localMediaPath: path.join(directory, filename),
        contextText: deriveContextText(filename),
      });
    }
  }
  return files;
}

export async function listLocalVaultCategories() {
  const countsByCategory = new Map<string, { total: number; images: number; videos: number; unposted: number }>();
  for (const file of await readLocalVaultFiles()) {
    const counts = countsByCategory.get(file.category) ?? { total: 0, images: 0, videos: 0, unposted: 0 };
    counts.total += 1;
    counts.unposted += 1;
    if (file.mediaType === "image") counts.images += 1;
    else counts.videos += 1;
    countsByCategory.set(file.category, counts);
  }
  return Array.from(countsByCategory, ([category, counts]) => ({ category, ...counts })).sort((left, right) => left.category.localeCompare(right.category));
}

export async function listLocalVaultItems(category: string) {
  return (await readLocalVaultFiles([category]))
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((file) => ({
      ...file,
      tags: tagsForFile(file),
      previewUrl: `/memes-content/downloads_${file.category}/${encodeURIComponent(file.filename)}`,
      isPosted: false,
    }));
}

export async function findLocalVaultItem(id: string): Promise<VaultFile | null> {
  return (await readLocalVaultFiles()).find((file) => file.id === id) ?? null;
}

export async function pickMemeVaultItems(limit: number): Promise<DiscoveryItem[]> {
  const vaultFiles = await readLocalVaultFiles(ALLOWED_CATEGORIES);
  const pools = new Map<string, VaultFile[]>();
  for (const category of ALLOWED_CATEGORIES) {
    pools.set(category, shuffle(vaultFiles.filter((file) => file.category === category)));
  }

  const picked: VaultFile[] = [];
  const maxRounds = ALLOWED_CATEGORIES.length * Math.ceil(limit / ITEMS_PER_CATEGORY_TURN) + ALLOWED_CATEGORIES.length;
  for (let round = 0; picked.length < limit && round < maxRounds; round += 1) {
    const pool = pools.get(ALLOWED_CATEGORIES[round % ALLOWED_CATEGORIES.length]) ?? [];
    for (let turn = 0; turn < ITEMS_PER_CATEGORY_TURN && picked.length < limit && pool.length > 0; turn += 1) {
      const preferredType = (picked.length + 1) % IMAGE_EVERY_N_PICKS === 0 ? "image" : "video";
      const selectedIndex = Math.max(0, pool.findIndex((file) => file.mediaType === preferredType));
      const [file] = pool.splice(selectedIndex, 1);
      picked.push(file);
    }
  }

  return picked.map((file, index) => {
    const contextLabel = file.contextText ?? file.filename.replace(/\.[^.]+$/, "");
    return {
      title: contextLabel,
      description: `${contextLabel} - meme (${file.category})`,
      url: `vault://${file.category}/${encodeURIComponent(file.filename)}`,
      source: "MemeVault",
      mediaType: file.mediaType,
      relevanceScore: Math.max(1, 100 - index),
      tags: tagsForFile(file),
      localMediaPath: file.localMediaPath,
    };
  });
}
