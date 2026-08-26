import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function listObjectPaths(storage, bucket, prefix = "") {
  const paths = [];
  let offset = 0;

  while (true) {
    const { data, error } = await storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Could not list ${bucket}/${prefix || ""}: ${error.message}`);
    if (!data?.length) break;

    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) {
        paths.push({ path: itemPath, size: Number(item.metadata?.size ?? 0) });
      } else {
        paths.push(...await listObjectPaths(storage, bucket, itemPath));
      }
    }

    if (data.length < 1000) break;
    offset += data.length;
  }

  return paths;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadEnvFile(path.join(rootDir, ".env.local"));
  loadEnvFile(path.join(rootDir, ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const bucket = getOption("--bucket") ?? process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault";
  const shouldDelete = process.argv.includes("--delete");
  const purgeVaultCatalog = process.argv.includes("--purge-vault-catalog");
  if (purgeVaultCatalog && bucket !== (process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault")) {
    throw new Error("--purge-vault-catalog can only be used with the meme-vault bucket.");
  }
  if (purgeVaultCatalog && !shouldDelete) throw new Error("--purge-vault-catalog requires --delete.");

  const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const objects = await listObjectPaths(supabase.storage, bucket);
  const totalBytes = objects.reduce((total, object) => total + object.size, 0);
  console.log(`${bucket}: ${objects.length} object(s), ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

  if (!shouldDelete) {
    console.log(`Dry run only. To delete: npm run storage:clean -- --bucket ${bucket} --delete${bucket === (process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault") ? " --purge-vault-catalog" : ""}`);
    return;
  }

  for (let start = 0; start < objects.length; start += 1000) {
    const paths = objects.slice(start, start + 1000).map((object) => object.path);
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) throw new Error(`Failed deleting objects ${start + 1}-${start + paths.length}: ${error.message}`);
    console.log(`Deleted ${Math.min(start + paths.length, objects.length)}/${objects.length} objects.`);
  }

  if (purgeVaultCatalog) {
    const { error } = await supabase.from("meme_vault_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) throw new Error(`Storage objects were deleted, but the meme catalog could not be cleared: ${error.message}`);
    console.log("Cleared meme_vault_items catalog rows.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Storage cleanup failed.");
  process.exitCode = 1;
});