export const FALLBACK_POST_MEDIA_URL = "https://picsum.photos/seed/only1marathon/1200/1200";

export function getPostMediaUrl(metadata?: Record<string, unknown> | null, publicUrl?: string | null) {
  if (publicUrl) return publicUrl;
  if (typeof metadata?.media_url === "string" && metadata.media_url.trim()) {
    return metadata.media_url;
  }
  return FALLBACK_POST_MEDIA_URL;
}
