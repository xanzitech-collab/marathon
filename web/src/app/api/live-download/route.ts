import { hasLocalSession } from "@/lib/local-auth";
import { extractMediaFromUrl } from "@/lib/discovery-media";

const ALLOWED_SOURCE_HOSTS = ["tiktok.com", "facebook.com", "youtube.com", "youtu.be", "twitter.com", "x.com"];
const MAX_BYTES = 300 * 1024 * 1024;

function isAllowedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_SOURCE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!(await hasLocalSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sourceUrl = new URL(request.url).searchParams.get("url");
  if (!sourceUrl || !isAllowedSourceUrl(sourceUrl)) {
    return Response.json({ error: "A supported TikTok, Facebook, YouTube, or X post URL is required." }, { status: 400 });
  }

  try {
    const mediaUrl = await extractMediaFromUrl(sourceUrl);
    if (!mediaUrl) {
      return Response.json({ error: "Could not extract a downloadable video from this post." }, { status: 422 });
    }

    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      return Response.json({ error: "Could not download this video." }, { status: 422 });
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return Response.json({ error: "This video is too large to download." }, { status: 413 });
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": response.headers.get("content-type")?.split(";")[0] || "video/mp4",
        "Content-Disposition": "attachment; filename=marathon-live-video.mp4",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not download this video." }, { status: 422 });
  }
}