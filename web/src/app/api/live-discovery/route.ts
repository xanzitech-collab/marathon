import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ContentDiscoveryService } from "@/lib/content-discovery";

const ALLOWED_PLATFORMS = new Set(["tiktok", "facebook", "youtube"]);

export async function GET(request: Request) {
  try {
    await requireUser();

    const { searchParams } = new URL(request.url);
    const platform = searchParams.get("platform");
    if (!platform || !ALLOWED_PLATFORMS.has(platform)) {
      return NextResponse.json({ error: "platform must be tiktok, facebook, or youtube" }, { status: 400 });
    }

    const discovery = new ContentDiscoveryService();
    const items = await discovery.browsePlatform(platform as "tiktok" | "facebook" | "youtube");

    return NextResponse.json({
      items: items.map((item) => ({
        url: item.url,
        title: item.title,
        description: item.description,
        tags: item.tags,
        source: item.source,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
