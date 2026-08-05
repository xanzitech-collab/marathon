import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function deriveCategory(folderName) {
  // downloads_9gag_relationship -> 9gag_relationship, downloads_funny -> funny
  return folderName.replace(/^downloads_/, "");
}

function deriveSource(category) {
  if (category.startsWith("9gag_")) return "9gag";
  if (category.startsWith("kapwing_")) return "kapwing";
  return "funny";
}

// Filenames look like "some-descriptive-slug_aB3xYz9.jpg" (real context) or
// just a random id like "05GkLie.jpg" (no usable context — Gemini vision
// handles those at verification time instead).
function deriveContextText(filenameNoExt) {
  const match = filenameNoExt.match(/^(.*)_[a-zA-Z0-9]{6,}$/);
  const slug = match ? match[1] : null;
  if (!slug || !slug.includes("-")) return null;
  return slug.replace(/-/g, " ").trim();
}

async function ensureBucket(supabase, bucket) {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error(`Could not list storage buckets: ${listError.message}`);

  const exists = (buckets ?? []).some((item) => item.name === bucket || item.id === bucket);
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(bucket, { public: false });
  if (createError) throw new Error(`Could not create '${bucket}' bucket: ${createError.message}`);
}

async function ensureVaultTableReady(supabase) {
  const { error } = await supabase.from("meme_vault_items").select("id").limit(1);
  if (!error) return;

  const missing = /could not find the table|relation .* does not exist/i.test(error.message);
  if (missing) {
    throw new Error("Missing meme_vault_items table. Apply migration supabase/migrations/20260804_0001_meme_vault.sql first.");
  }
  throw new Error(`Could not validate meme_vault_items table: ${error.message}`);
}

async function main() {
  const scriptFilePath = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(scriptFilePath), "..");
  loadEnvFile(path.join(rootDir, ".env.local"));
  loadEnvFile(path.join(rootDir, ".env"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const bucket = process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault";
  await ensureVaultTableReady(supabase);
  await ensureBucket(supabase, bucket);

  const contentRoot = path.join(rootDir, "public", "memes-content");
  if (!fs.existsSync(contentRoot)) {
    throw new Error(`Meme content directory does not exist: ${contentRoot}`);
  }

  const folders = fs.readdirSync(contentRoot, { withFileTypes: true }).filter((d) => d.isDirectory());

  let totalFiles = 0;
  let alreadyCatalogued = 0;
  let uploaded = 0;
  let failed = 0;

  for (const folder of folders) {
    const category = deriveCategory(folder.name);
    const source = deriveSource(category);
    const folderPath = path.join(contentRoot, folder.name);
    const files = fs
      .readdirSync(folderPath)
      .filter((name) => VIDEO_EXT.has(path.extname(name).toLowerCase()) || IMAGE_EXT.has(path.extname(name).toLowerCase()));

    // Know which files in this category are already catalogued so we never
    // re-upload or re-insert the same file on repeated runs.
    const { data: existingRows, error: existingError } = await supabase
      .from("meme_vault_items")
      .select("original_filename")
      .eq("category", category);

    if (existingError) {
      console.error(`Could not read existing rows for category ${category}: ${existingError.message}`);
      continue;
    }

    const existing = new Set((existingRows ?? []).map((row) => row.original_filename));
    let categoryUploaded = 0;

    for (const filename of files) {
      totalFiles += 1;
      if (existing.has(filename)) {
        alreadyCatalogued += 1;
        continue;
      }

      const ext = path.extname(filename).toLowerCase();
      const mediaType = VIDEO_EXT.has(ext) ? "video" : "image";
      const filenameNoExt = filename.slice(0, -ext.length);
      const contextText = deriveContextText(filenameNoExt);
      const storagePath = `${category}/${filename}`;
      const sourcePath = path.join(folderPath, filename);
      const bytes = fs.readFileSync(sourcePath);

      const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, bytes, {
        upsert: true,
        contentType: mediaType === "video" ? "video/mp4" : `image/${ext.slice(1) === "jpg" ? "jpeg" : ext.slice(1)}`,
      });

      if (uploadError) {
        console.error(`Upload failed for ${storagePath}: ${uploadError.message}`);
        failed += 1;
        continue;
      }

      const { error: insertError } = await supabase.from("meme_vault_items").insert({
        category,
        source,
        media_type: mediaType,
        storage_path: storagePath,
        original_filename: filename,
        context_text: contextText,
      });

      if (insertError) {
        console.error(`Catalog insert failed for ${storagePath}: ${insertError.message}`);
        failed += 1;
        continue;
      }

      uploaded += 1;
      categoryUploaded += 1;
    }

    console.log(`${category}: ${files.length} files, ${categoryUploaded} newly uploaded`);
  }

  console.log(
    `\nDone. Total files scanned: ${totalFiles}, already catalogued: ${alreadyCatalogued}, newly uploaded: ${uploaded}, failed: ${failed}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Meme vault upload failed");
  process.exitCode = 1;
});
