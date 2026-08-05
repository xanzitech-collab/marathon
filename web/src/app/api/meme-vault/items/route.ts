import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const VAULT_BUCKET = process.env.SUPABASE_MEME_VAULT_BUCKET ?? "meme-vault";

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    if (!category) return NextResponse.json({ error: "category is required" }, { status: 400 });

    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("meme_vault_items")
      .select("id, category, source, media_type, storage_path, original_filename, context_text, is_posted")
      .eq("category", category)
      .order("original_filename", { ascending: true })
      .limit(300);

    if (error) throw error;

    const items = await Promise.all(
      (rows ?? []).map(async (row) => {
        const { data: signed } = await admin.storage.from(VAULT_BUCKET).createSignedUrl(row.storage_path, 3600);
        return {
          id: row.id,
          category: row.category,
          source: row.source,
          mediaType: row.media_type as "image" | "video",
          originalFilename: row.original_filename,
          contextText: row.context_text,
          isPosted: row.is_posted,
          previewUrl: signed?.signedUrl ?? null,
        };
      }),
    );

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
