function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Vercel functions have a read-only filesystem outside of /tmp and nothing
// beyond the repo gets deployed, so a local FACEBOOK_COOKIES_FILE path only
// works in dev. The primary source is the cookies.txt uploaded from the
// dashboard (stored in Supabase, works the same in dev and on Vercel) —
// downloaded to /tmp and re-checked periodically so a fresh upload replaces
// the previous one without needing a redeploy. FACEBOOK_COOKIES_FILE /
// FACEBOOK_COOKIES_CONTENT env vars remain as a local-only fallback.
const COOKIES_CACHE_TTL_MS = 5 * 60_000;
let cachedCookiesPath: string | null | undefined;
let cachedCookiesAt = 0;

async function downloadCookiesFromSupabase(): Promise<string | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from("app-secrets").download("facebook-cookies.txt");
    if (error || !data) return null;

    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const buffer = Buffer.from(await data.arrayBuffer());
    const tmpPath = path.join(os.tmpdir(), "facebook-cookies.txt");
    await fs.writeFile(tmpPath, buffer);
    return tmpPath;
  } catch {
    return null;
  }
}

async function resolveFacebookCookiesFile(): Promise<string | undefined> {
  if (cachedCookiesPath !== undefined && Date.now() - cachedCookiesAt < COOKIES_CACHE_TTL_MS) {
    return cachedCookiesPath ?? undefined;
  }

  const fromSupabase = await downloadCookiesFromSupabase();
  if (fromSupabase) {
    cachedCookiesPath = fromSupabase;
    cachedCookiesAt = Date.now();
    return fromSupabase;
  }

  const directPath = process.env.FACEBOOK_COOKIES_FILE;
  if (directPath) {
    cachedCookiesPath = directPath;
    cachedCookiesAt = Date.now();
    return directPath;
  }

  const encodedContent = process.env.FACEBOOK_COOKIES_CONTENT;
  if (!encodedContent) {
    cachedCookiesPath = null;
    cachedCookiesAt = Date.now();
    return undefined;
  }

  try {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const decoded = Buffer.from(encodedContent, "base64").toString("utf8");
    const tmpPath = path.join(os.tmpdir(), "facebook-cookies.txt");
    await fs.writeFile(tmpPath, decoded, "utf8");
    cachedCookiesPath = tmpPath;
    cachedCookiesAt = Date.now();
    return tmpPath;
  } catch (error) {
    console.warn(`[discovery-media] Could not materialize FACEBOOK_COOKIES_CONTENT: ${error instanceof Error ? error.message : String(error)}`);
    cachedCookiesPath = null;
    cachedCookiesAt = Date.now();
    return undefined;
  }
}

async function withRetries<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function isTikTokUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes("tiktok.com");
  } catch {
    return false;
  }
}

function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("youtube.com") || host.includes("youtu.be");
  } catch {
    return false;
  }
}

// Facebook's bare profile/reels-index pages have nothing to extract (see
// LOGIN_WALLED_HOSTS below), but a SPECIFIC video/reel URL
// (facebook.com/<page>/videos/<id>/ or /reel/<id>) is a real, individually
// downloadable clip via yt-dlp — confirmed live, no login required.
function isFacebookVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!(host === "facebook.com" || host.endsWith(".facebook.com"))) return false;
    return /\/(videos|reel|watch)\/([^/?]*\d)/i.test(parsed.pathname) || parsed.searchParams.has("v");
  } catch {
    return false;
  }
}

// These platforms show a generic "log in to see this" page to anonymous
// requests — screenshotting or og:image-scraping them never shows the real
// post, just a login wall. Confirmed live: multiple posts went out as
// literal screenshots of Facebook/Instagram login prompts.
//
// urlebird.com (and similar) are third-party TikTok "viewer" mirror sites —
// DuckDuckGo surfaces them instead of the real tiktok.com URL sometimes.
// There's no API support for downloading from these mirrors, so a
// screenshot of the mirror page is exactly the kind of junk to skip instead.
const LOGIN_WALLED_HOSTS = [
  "instagram.com",
  "facebook.com",
  "snapchat.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "urlebird.com",
  "tiktokv.com",
];

function isLoginWalledUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOGIN_WALLED_HOSTS.some((walled) => host === walled || host.endsWith(`.${walled}`));
  } catch {
    return false;
  }
}

// A search results page is never real content — screenshotting one and
// posting it happened live (a discovered item's source URL fell back to a
// bare google.com/search link with no real target page). Belt-and-suspenders
// against any other source ever doing the same thing.
const SEARCH_ENGINE_HOSTS = ["google.com", "bing.com", "duckduckgo.com", "yahoo.com", "search.google.com"];

function isSearchEngineUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isSearchHost = SEARCH_ENGINE_HOSTS.some((engine) => host === engine || host.endsWith(`.${engine}`));
    return isSearchHost && (parsed.pathname === "/" || parsed.pathname.startsWith("/search") || parsed.pathname === "/html");
  } catch {
    return false;
  }
}

/**
 * yt-dlp gets blocked by TikTok's anti-bot checks on a large fraction of
 * individual videos (confirmed live). @tobyg74/tiktok-api-dl talks to
 * TikTok's own public download mirrors and succeeds far more often — tried
 * first for TikTok, with yt-dlp kept as a second attempt.
 */
async function extractTikTokVideoViaApiDl(sourceUrl: string): Promise<string | null> {
  try {
    const { Downloader } = await import("@tobyg74/tiktok-api-dl");

    const v3 = await Downloader(sourceUrl, { version: "v3" });
    if (v3.status === "success") {
      const url = v3.result?.videoHD || v3.result?.videoSD;
      if (url) return url;
    }

    const v1 = await Downloader(sourceUrl, { version: "v1" });
    if (v1.status === "success") {
      const url = v1.result?.video?.downloadAddr?.[0] || v1.result?.video?.playAddr?.[0];
      if (url) return url;
    }

    return null;
  } catch (error) {
    console.warn(`[discovery-media] tiktok-api-dl extraction failed for ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolves an actual playable video stream URL for YouTube/TikTok links via
 * yt-dlp (talks to the platforms' own public player APIs — no anti-bot
 * bypass involved, same mechanism any client uses). Returned URLs are
 * short-lived/session-tied, so the caller must download immediately.
 */
async function extractYtDlpVideoUrl(sourceUrl: string, options?: { extractorArgs?: string; cookiesFile?: string }): Promise<string | null> {
  try {
    return await withRetries(async () => {
      const youtubedl = (await import("youtube-dl-exec")).default;
      const info = (await youtubedl(sourceUrl, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        format: "best[ext=mp4][filesize<50M]/best[ext=mp4]/best",
        ...(options?.extractorArgs ? { extractorArgs: options.extractorArgs } : {}),
        ...(options?.cookiesFile ? { cookies: options.cookiesFile } : {}),
      })) as { url?: string; requested_downloads?: Array<{ url?: string }> };

      const url = info.url ?? info.requested_downloads?.[0]?.url ?? null;
      if (!url) throw new Error("yt-dlp returned no url");
      return url;
    }, 3, 2000);
  } catch (error) {
    console.warn(`[discovery-media] yt-dlp extraction failed for ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Lists the most recent videos on a TikTok profile via yt-dlp's flat-playlist
 * mode. This hits a different, less-guarded TikTok endpoint than single-video
 * detail extraction, so it works even though extracting a playable file for
 * an individual TikTok video often gets blocked (see extractYtDlpVideoUrl).
 */
export async function extractTikTokProfileVideos(
  handle: string,
  limit: number,
): Promise<Array<{ id: string; url: string; title: string }>> {
  try {
    const youtubedl = (await import("youtube-dl-exec")).default;
    const info = (await youtubedl(`https://www.tiktok.com/@${handle}`, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true,
      playlistEnd: limit,
    })) as { entries?: Array<{ id?: string; webpage_url?: string; url?: string; title?: string }> };

    return (info.entries ?? [])
      .map((entry) => ({
        id: entry.id ?? "",
        url: entry.webpage_url ?? entry.url ?? "",
        title: entry.title ?? "",
      }))
      .filter((entry) => entry.id && entry.url);
  } catch (error) {
    console.warn(`[discovery-media] TikTok profile listing failed for @${handle}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function toAbsoluteUrl(candidate: string, baseUrl: string): string {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return candidate;
  }
}

function extractMetaContent(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

export function normalizeSourceUrl(rawUrl: string): string {
  let candidate = rawUrl.trim().replace(/&amp;/gi, "&");
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }

  try {
    const parsed = new URL(candidate);

    // DuckDuckGo search results often wrap the destination in ?uddg=
    if (parsed.hostname.toLowerCase().includes("duckduckgo.com")) {
      const wrapped = parsed.searchParams.get("uddg");
      if (wrapped) {
        return decodeURIComponent(wrapped).replace(/&amp;/gi, "&");
      }
    }

    return parsed.toString();
  } catch {
    return candidate;
  }
}

function screenshotFallbackUrl(sourceUrl: string): string {
  // thum.io expects the target URL appended raw, not percent-encoded — its
  // backend (Tomcat) rejects encoded slashes in the path with a 400, which
  // silently broke this fallback for every source (confirmed by direct test).
  return `https://image.thum.io/get/width/1200/crop/900/noanimate/${sourceUrl}`;
}

async function extractOgImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: withTimeout(9000),
    });

    if (!response.ok) return null;
    const html = await response.text();

    const ogImage = extractMetaContent(html, [
      /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i,
      /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i,
    ]);

    return ogImage ? toAbsoluteUrl(ogImage, response.url) : null;
  } catch {
    return null;
  }
}

export async function extractMediaFromUrl(sourceUrl: string): Promise<string | null> {
  if (!sourceUrl) return null;
  const normalizedSource = normalizeSourceUrl(sourceUrl);

  // TikTok: try the dedicated downloader first (far more reliable than
  // yt-dlp against TikTok's current anti-bot checks), then yt-dlp. Same rule
  // as YouTube below — a real video or nothing, never a screenshot dressed
  // up as if it were the clip.
  if (isTikTokUrl(normalizedSource)) {
    const apiDlUrl = await extractTikTokVideoViaApiDl(normalizedSource);
    if (apiDlUrl && (await validateMediaUrl(apiDlUrl))) {
      return apiDlUrl;
    }

    const ytDlpUrl = await extractYtDlpVideoUrl(normalizedSource);
    if (ytDlpUrl && (await validateMediaUrl(ytDlpUrl))) {
      return ytDlpUrl;
    }

    console.warn(`[discovery-media] Skipping TikTok item (no real footage extractable, thumbnails are not allowed): ${normalizedSource}`);
    return null;
  }

  // YouTube: ALWAYS require real video, never a thumbnail — a static image
  // cropped into a reel looks cheap and isn't what "posting a video" means.
  // YouTube's "Sign in to confirm you're not a bot" check blocks the default
  // web client often, so try the android client (no login check) first,
  // then plain yt-dlp as a second attempt. If neither gets real footage,
  // skip this item entirely instead of falling back to its thumbnail.
  if (isYouTubeUrl(normalizedSource)) {
    const androidUrl = await extractYtDlpVideoUrl(normalizedSource, { extractorArgs: "youtube:player_client=android" });
    if (androidUrl && (await validateMediaUrl(androidUrl))) {
      return androidUrl;
    }

    const videoUrl = await extractYtDlpVideoUrl(normalizedSource);
    if (videoUrl && (await validateMediaUrl(videoUrl))) {
      return videoUrl;
    }

    console.warn(`[discovery-media] Skipping YouTube item (no real footage extractable, thumbnails are not allowed): ${normalizedSource}`);
    return null;
  }

  // Facebook: only a specific video/reel URL is extractable — bare
  // profile/reels-index pages fall through to the login-walled skip below.
  // Same "real video or skip" rule as TikTok/YouTube, never a screenshot.
  // Facebook serves real video to logged-in requests only (confirmed by a
  // reference scraper that requires manual Chrome login) — an exported
  // Netscape cookies.txt from a logged-in session lets yt-dlp authenticate
  // the same way, without which most individual reel/video URLs 404 or 403.
  if (isFacebookVideoUrl(normalizedSource)) {
    const cookiesFile = await resolveFacebookCookiesFile();
    const fbVideoUrl = await extractYtDlpVideoUrl(normalizedSource, cookiesFile ? { cookiesFile } : undefined);
    if (fbVideoUrl && (await validateMediaUrl(fbVideoUrl))) {
      return fbVideoUrl;
    }

    console.warn(`[discovery-media] Skipping Facebook item (no real footage extractable, thumbnails are not allowed): ${normalizedSource}`);
    return null;
  }

  if (isLoginWalledUrl(normalizedSource)) {
    console.warn(`[discovery-media] Skipping login-walled source (screenshot would just show a login page): ${normalizedSource}`);
    return null;
  }

  if (isSearchEngineUrl(normalizedSource)) {
    console.warn(`[discovery-media] Skipping search-engine results page (screenshot would show a search UI, not real content): ${normalizedSource}`);
    return null;
  }

  const ogImage = await extractOgImage(normalizedSource);
  if (ogImage && (await validateMediaUrl(ogImage))) {
    return ogImage;
  }

  // Last resort: screenshot the source page so discovery can still queue media.
  const screenshotUrl = screenshotFallbackUrl(normalizedSource);
  if (await validateMediaUrl(screenshotUrl)) {
    return screenshotUrl;
  }

  return null;
}

export async function validateMediaUrl(url: string | null | undefined): Promise<boolean> {
  if (!url) return false;

  // Some CDN mirrors (e.g. TikTok's own download hosts) serve real video as
  // application/octet-stream instead of video/mp4 — treat a large octet-stream
  // as media too, since a tiny one is far more likely to be an error page.
  const isMedia = (contentType: string | null, contentLength?: string | null) => {
    if (contentType?.startsWith("image/") || contentType?.startsWith("video/")) return true;
    if (contentType?.startsWith("application/octet-stream")) {
      const length = Number(contentLength ?? 0);
      return Number.isFinite(length) && length > 100_000;
    }
    return false;
  };

  try {
    const headRes = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: withTimeout(7000),
    });

    if (headRes.ok && isMedia(headRes.headers.get("content-type"), headRes.headers.get("content-length"))) {
      return true;
    }
  } catch {
    // Some hosts reject HEAD. Fall through to range GET.
  }

  try {
    const getRes = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-1" },
      signal: withTimeout(9000),
    });

    if (getRes.ok && isMedia(getRes.headers.get("content-type"), getRes.headers.get("content-range")?.split("/")[1])) {
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const fullGetRes = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: withTimeout(12000),
    });

    return fullGetRes.ok && isMedia(fullGetRes.headers.get("content-type"), fullGetRes.headers.get("content-length"));
  } catch {
    return false;
  }
}
