import type { SupabaseClient } from "@supabase/supabase-js";
import type { DiscoveryItem } from "@/lib/content-discovery";

const VAULT_BUCKET = process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault";

// Only these curated, pre-downloaded folders/categories are ever eligible for
// posting — every other downloaded category (9gag_cosplay, kapwing_drake,
// etc.) stays on disk/catalogued but is intentionally excluded from selection.
const ALLOWED_CATEGORIES = [
  "kapwing_video",
  "9gag_humor",
  "9gag_lifestyle",
  "9gag_motorvehicles",
  "9gag_music",
  "9gag_wtf",
];

// Take this many items per category before moving to the next one in the
// rotation, so one category never gets hammered while others sit unused.
const ITEMS_PER_CATEGORY_TURN = 2;

// Video-first shaping: 1 image for every 3 videos (1-in-4 overall).
const IMAGE_EVERY_N_PICKS = 4;

interface VaultRow {
  id: string;
  category: string;
  source: string;
  media_type: "image" | "video";
  storage_path: string;
  original_filename: string;
  context_text: string | null;
  last_posted_at: string | null;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Picks unposted items from the locally-curated meme vault, restricted to a
 * hardcoded set of categories, cycling through them round-robin (2 at a time)
 * so no single folder gets drained while others sit untouched, and shaping
 * the video/image mix to roughly 3 videos per image. Signed URLs are
 * short-lived — the caller (discoverAndQueueContent) downloads and
 * re-uploads to bot-media immediately, so a 1 hour expiry is plenty.
 */
export async function pickMemeVaultItems(admin: SupabaseClient, limit: number): Promise<DiscoveryItem[]> {
  const { data: rows } = await admin
    .from("meme_vault_items")
    .select("*")
    .eq("is_posted", false)
    .in("category", ALLOWED_CATEGORIES);

  const pools = new Map<string, VaultRow[]>();
  for (const category of ALLOWED_CATEGORIES) pools.set(category, []);
  for (const row of (rows ?? []) as VaultRow[]) {
    pools.get(row.category)?.push(row);
  }
  for (const category of ALLOWED_CATEGORIES) {
    pools.set(category, shuffle(pools.get(category) ?? []));
  }

  // Resume the rotation where it left off: whichever allowed category was
  // used least recently (never-posted categories rank first) goes next —
  // this survives dev server restarts since it's derived from real DB state,
  // not an in-memory counter.
  const { data: recencyRows } = await admin
    .from("meme_vault_items")
    .select("category, last_posted_at")
    .in("category", ALLOWED_CATEGORIES)
    .eq("is_posted", true);

  const lastPostedByCategory = new Map<string, number>();
  for (const row of recencyRows ?? []) {
    const ts = row.last_posted_at ? new Date(row.last_posted_at).getTime() : 0;
    const current = lastPostedByCategory.get(row.category) ?? 0;
    if (ts > current) lastPostedByCategory.set(row.category, ts);
  }

  const order = [...ALLOWED_CATEGORIES].sort((a, b) => {
    const aTime = lastPostedByCategory.get(a) ?? 0;
    const bTime = lastPostedByCategory.get(b) ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return ALLOWED_CATEGORIES.indexOf(a) - ALLOWED_CATEGORIES.indexOf(b);
  });
  const startIndex = ALLOWED_CATEGORIES.indexOf(order[0]);
  const rotation = [...ALLOWED_CATEGORIES.slice(startIndex), ...ALLOWED_CATEGORIES.slice(0, startIndex)];

  const picked: VaultRow[] = [];
  const maxRounds = rotation.length * Math.ceil(limit / ITEMS_PER_CATEGORY_TURN) + rotation.length;
  let round = 0;

  while (picked.length < limit && round < maxRounds) {
    const category = rotation[round % rotation.length];
    const pool = pools.get(category) ?? [];

    for (let turn = 0; turn < ITEMS_PER_CATEGORY_TURN && picked.length < limit && pool.length > 0; turn++) {
      const wantsImage = (picked.length + 1) % IMAGE_EVERY_N_PICKS === 0;
      const preferredType = wantsImage ? "image" : "video";

      let takeIndex = pool.findIndex((row) => row.media_type === preferredType);
      if (takeIndex === -1) takeIndex = 0; // fall back to whatever this category has left

      const [row] = pool.splice(takeIndex, 1);
      picked.push(row);
    }

    round++;
    if ([...pools.values()].every((remaining) => remaining.length === 0)) break;
  }

  const items: DiscoveryItem[] = [];
  for (let i = 0; i < picked.length; i++) {
    const row = picked[i];
    const { data: signed } = await admin.storage.from(VAULT_BUCKET).createSignedUrl(row.storage_path, 3600);
    if (!signed?.signedUrl) continue;

    const contextLabel = row.context_text ?? row.original_filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

    items.push({
      // Always mention "meme" so the focus-alignment gate accepts every category.
      title: contextLabel,
      description: `${contextLabel} — meme (${row.category})`,
      url: `vault://${row.id}`,
      source: "MemeVault",
      mediaType: row.media_type,
      // Strictly decreasing so ContentDiscoveryService's later relevance-score
      // sort can't undo this round-robin pick order (see rankForTarget's
      // MemeVault carve-out).
      relevanceScore: Math.max(1, 100 - i),
      tags: ["meme", row.category, row.source],
      mediaUrl: signed.signedUrl,
      vaultItemId: row.id,
    });
  }

  return items;
}


export async function markVaultItemPosted(admin: SupabaseClient, vaultItemId: string): Promise<void> {
  const { data } = await admin.from("meme_vault_items").select("posted_count").eq("id", vaultItemId).single();
  await admin
    .from("meme_vault_items")
    .update({
      is_posted: true,
      posted_count: (data?.posted_count ?? 0) + 1,
      last_posted_at: new Date().toISOString(),
    })
    .eq("id", vaultItemId);
}
