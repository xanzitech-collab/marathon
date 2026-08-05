import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export async function GET() {
  try {
    const { supabase } = await requireUser();

    const { data, error } = await supabase
      .from("meme_vault_items")
      .select("category, media_type, is_posted");

    if (error) throw error;

    const byCategory = new Map<string, { total: number; images: number; videos: number; unposted: number }>();
    for (const row of data ?? []) {
      const entry = byCategory.get(row.category) ?? { total: 0, images: 0, videos: 0, unposted: 0 };
      entry.total += 1;
      if (row.media_type === "image") entry.images += 1;
      if (row.media_type === "video") entry.videos += 1;
      if (!row.is_posted) entry.unposted += 1;
      byCategory.set(row.category, entry);
    }

    const categories = Array.from(byCategory.entries())
      .map(([category, counts]) => ({ category, ...counts }))
      .sort((a, b) => a.category.localeCompare(b.category));

    return NextResponse.json({ categories });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
