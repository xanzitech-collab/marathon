import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listLocalVaultItems } from "@/lib/meme-vault";

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    if (!category) return NextResponse.json({ error: "category is required" }, { status: 400 });

    const items = (await listLocalVaultItems(category)).slice(0, 300).map((item) => ({
      id: item.id,
      category: item.category,
      source: item.source,
      mediaType: item.mediaType,
      originalFilename: item.filename,
      contextText: item.contextText,
      tags: item.tags,
      isPosted: item.isPosted,
      previewUrl: item.previewUrl,
    }));
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
