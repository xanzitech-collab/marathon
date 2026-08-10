import { requireUser } from "@/lib/auth";
import { ContentDiscoveryService, type DiscoveryItem } from "@/lib/content-discovery";

const ALLOWED_PLATFORMS = new Set(["tiktok", "facebook", "youtube"]);

function serializeItem(item: DiscoveryItem) {
  return { url: item.url, title: item.title, description: item.description, tags: item.tags, source: item.source };
}

export async function GET(request: Request) {
  try {
    await requireUser();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");
  if (!platform || !ALLOWED_PLATFORMS.has(platform)) {
    return Response.json({ error: "platform must be tiktok, facebook, or youtube" }, { status: 400 });
  }

  const discovery = new ContentDiscoveryService();
  const encoder = new TextEncoder();

  // Streamed as newline-delimited JSON instead of one big response at the
  // end — each line is a small batch (one TikTok account, one search query)
  // as soon as it resolves, so the Live tab can show results as they arrive
  // instead of a long wait followed by everything appearing at once.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      try {
        await discovery.browsePlatform(platform as "tiktok" | "facebook" | "youtube", (items) => {
          send({ items: items.map(serializeItem) });
        });
        send({ done: true });
      } catch (error) {
        send({ error: error instanceof Error ? error.message : "Failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
