import { ARTIST_CONTEXT } from "@/lib/artist";
import { pickMemeVaultItems } from "@/lib/meme-vault";
import { extractTikTokProfileVideos, listRecentTweets } from "@/lib/discovery-media";

export interface DiscoveryItem {
  title: string;
  description: string;
  url: string;
  source: string;
  mediaType: "article" | "video" | "image" | "social_post" | "news" | "interview" | "text";
  relevanceScore: number;
  tags: string[];
  mediaUrl?: string;
  thumbnailUrl?: string;
  localMediaPath?: string;
  contextHint?: string;
}

interface BotRecord {
  id: string;
  persona: string;
  additional_persona?: string | null;
  content_target: string;
  city?: string | null;
  country?: string | null;
  custom_target_prompt?: string | null;
}

// Each yt-dlp call spawns a real child process — firing all of them at once
// (e.g. 14 TikTok handles via Promise.allSettled) can spike past the ~512MB
// free-tier container's memory limit and get the whole app OOM-killed,
// surfacing as a 502 from Render's proxy instead of a normal JSON error.
// Capping concurrency keeps peak memory bounded at the cost of a bit more time.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  // Called as each individual item finishes, instead of only after every
  // item completes — lets the caller stream partial results out immediately.
  onResult?: (item: T, result: PromiseSettledResult<R>) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      let result: PromiseSettledResult<R>;
      try {
        result = { status: "fulfilled", value: await fn(items[index]) };
      } catch (error) {
        result = { status: "rejected", reason: error };
      }
      results[index] = result;
      onResult?.(items[index], result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Fan/edit accounts known to regularly post or repost content featuring the
// artist — crawled alongside the artist's own profile so "Live" browsing has
// real depth instead of relying on one account's fixed upload count.
const TIKTOK_CURATED_FAN_HANDLES = [
  "millionaire_mentality_7",
  "luxe.aestique",
  "domersim",
  "sending234",
  ".scenesclips",
  "caarif63",
  "_m.r.e.n.o_",
  "puregirls6",
  "the.black.zx6r",
  "footyedits10.1",
  "luxury_exotics_1",
  "momentsofgregory",
  "majesticnaturemoments",
  "millionaire.zw",
  "byarvelor",
  "love4infinity3",
  "lucidxi_reelz",
  "ghost986quotes",
  "darknightbigg",
  "only.mito1",
  "swxft.404",
  "tymekbanka",
  "zyron.03",
  "w2rld.stan.account",
  "dyinqwx",
  "sydneyevelyn_",
  "afrolinkzglobal",
  "_danny_vibez",
  "dancevibez26",
  "megz.kudi_",
  "kool_vibes6",
  "its.dylbad",
  "shamah_hhh",
  "rainbowdj__",
  "its_sandiego",
];

export class ContentDiscoveryService {
  private readonly artistName = ARTIST_CONTEXT.name;
  private readonly artistHandle = ARTIST_CONTEXT.instagramHandle;
  private readonly tiktokHandle = ARTIST_CONTEXT.tiktokHandle;
  private readonly facebookHandle = ARTIST_CONTEXT.facebookHandle;
  private readonly youtubeHandle = ARTIST_CONTEXT.youtubeHandle;
  private readonly twitterHandle = ARTIST_CONTEXT.twitterHandle;
  private readonly songs = ARTIST_CONTEXT.songs;

  /**
   * Live browse for the manual "Live" tab: lists real candidate videos for
   * one specific platform on demand, without resolving actual downloadable
   * media yet (that happens per-item when the user selects one, since
   * resolution is the slow/failure-prone step — see discovery-media.ts).
   *
   * onBatch, when given, is called with each small group of items as soon as
   * that particular source (one TikTok account, one search query, etc.)
   * finishes — instead of the caller waiting for every source to complete
   * before seeing anything, which is how this used to work.
   */
  async browsePlatform(
    platform: "tiktok" | "facebook" | "youtube" | "twitter",
    onBatch?: (items: DiscoveryItem[]) => void,
  ): Promise<DiscoveryItem[]> {
    const seen = new Set<string>();
    const all: DiscoveryItem[] = [];
    const emit = (rawBatch: DiscoveryItem[]) => {
      const fresh = rawBatch.filter((item) => {
        const key = `${item.source}:${item.url}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length === 0) return;
      all.push(...fresh);
      onBatch?.(fresh);
    };

    if (platform === "tiktok") {
      // The artist's own profile is a small, fixed pool (yt-dlp only ever
      // lists the same ~15 uploads) — it ran dry immediately, returning the
      // exact same results every browse. Fan-content search adds real variety.
      await Promise.all([this.crawlTikTokProfile(emit), this.crawlTikTokFanSearch(emit)]);
      return this.shuffle(this.deduplicate(all));
    }
    if (platform === "facebook") {
      await this.crawlFacebookVideos(emit);
      return this.shuffle(this.deduplicate(all));
    }
    if (platform === "twitter") {
      await this.crawlTwitterProfile(emit);
      return this.shuffle(this.deduplicate(all));
    }
    await this.crawlYouTubeSearch(emit);
    return this.shuffle(this.deduplicate(all));
  }

  async discoverContent(bot: BotRecord, options?: { limit?: number }): Promise<DiscoveryItem[]> {
    const limit = options?.limit ?? 3;
    // Shuffle so repeated runs explore different queries instead of always
    // hammering the same first few and re-finding (then exhausting) the same
    // handful of search results.
    const queries = this.shuffle(this.buildQueries(bot));
    const isMemeTarget = bot.content_target === "memes";

    const sources: Array<Promise<DiscoveryItem[]>> = [];

    // Meme mode is vault-only, period — never mix in live crawling/search.
    // Every other mode shares this same TikTok/Facebook fan-content baseline;
    // isFocusAligned()/rankForTarget() downstream still filter it to fit
    // whatever that specific mode actually wants.
    if (!isMemeTarget) {
      // The artist's own TikTok page is the highest-priority source for fan
      // engagement content — real first-party clips, not just search results.
      sources.push(this.crawlTikTokProfile());
      // Facebook has no flat-playlist listing like TikTok (yt-dlp rejects the
      // profile/reels index page outright), so real videos are found via
      // search instead, then each specific video URL is extracted directly.
      sources.push(this.crawlFacebookVideos());
    }

    if (!isMemeTarget && process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) {
      sources.push(this.crawlGoogle(queries, bot));
    }

    if (!isMemeTarget && process.env.REDDIT_VIDEO_SCRAPE_ENABLED === "true") {
      sources.push(this.crawlRedditVideos(bot));
    }

    if (isMemeTarget) {
      // Meme mode reads only the local curated vault and never falls through
      // to any crawl source above.
      sources.push(pickMemeVaultItems(options?.limit ?? 20));
    }

    if (!isMemeTarget) {
      sources.push(this.crawlWikipedia());
    }
    if (!isMemeTarget) {
      sources.push(this.crawlGenericWeb(queries, bot));
    }

    const results = await Promise.allSettled(sources);
    const items = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

    const ranked = this.rankForTarget(items, bot);
    const unique = this.deduplicate(ranked).sort((a, b) => b.relevanceScore - a.relevanceScore);
    return this.enrichWithMedia(unique.slice(0, limit));
  }

  private shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Bare profile/channel root URLs (e.g. instagram.com/handle, a YouTube
  // channel page) never resolve to a single downloadable piece of media —
  // they always end up skipped as "no_downloadable_media", wasting a
  // discovery slot every run. Filter them out before ranking so a real,
  // resolvable result can take that slot instead.
  private isProfileOrChannelRootUrl(url: string): boolean {
    let decoded = url;
    try {
      const ddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (ddgMatch) decoded = decodeURIComponent(ddgMatch[1]);
    } catch {
      // fall through with the raw url
    }
    const rootPatterns = [
      /instagram\.com\/[^/?]+\/?(\?.*)?$/i,
      /facebook\.com\/[^/?]+\/?(\?.*)?$/i,
      /twitter\.com\/[^/?]+\/?(\?.*)?$/i,
      /x\.com\/[^/?]+\/?(\?.*)?$/i,
      /youtube\.com\/(channel\/|@)[^/?]+\/?(\?.*)?$/i,
      /tiktok\.com\/@[^/?]+\/?(\?.*)?$/i,
      // SoundCloud bare profile pages (no track slug) have no useful og:image
      // and always fall through to the same generic page screenshot.
      /soundcloud\.com\/[^/?]+\/?(\?.*)?$/i,
    ];
    return rootPatterns.some((pattern) => pattern.test(decoded));
  }

  private buildQueries(bot: BotRecord): string[] {
    const locationHint = [bot.city, bot.country].filter(Boolean).join(" ");
    if (bot.content_target === "memes") {
      const memeQueries = [
        "viral meme image",
        "funny reaction meme",
        "street meme screenshot",
        "cars on road meme",
        "motorcycle stunt meme",
        "movie clip meme",
        "trending meme template",
      ];
      if (locationHint) {
        memeQueries.push(`${locationHint} meme`);
      }
      return Array.from(new Set(memeQueries));
    }

    const base = [
      `${this.artistName} news`,
      `${this.artistName} interview`,
      `${this.artistName} performance`,
      `${this.artistName} new music`,
      `${this.artistName} ${this.songs[0]}`,
      `${this.artistName} ${this.songs[1]}`,
      `${this.artistName} ${bot.persona}`,
    ];

    if (bot.content_target === "memes") {
      base.push(
        "viral meme image",
        "funny meme screenshot",
        "reaction meme template",
        "cars drifting meme",
        "motorcycle stunt meme",
        "movie scene meme",
        "street culture meme",
      );
    }

    if (bot.content_target === "viral_trends") {
      base.push("viral video clip", "trending social clip", "reels trend");
    }

    if (bot.content_target === "fan_engagement" || bot.content_target === "fan_reactions") {
      // site:tiktok.com biases DuckDuckGo toward OTHER creators' TikToks about
      // the artist (fan covers, reactions, duets) instead of just the
      // artist's own uploads — TikTok's own search requires a logged-in
      // session we deliberately don't use (account-security/ToS risk), so
      // this is the safe way to surface other accounts/pages.
      base.push(
        `${this.artistName} tiktok`,
        `site:tiktok.com ${this.artistName}`,
        `${this.artistName} fan reaction`,
        `${this.artistName} cover`,
      );
    }

    if (locationHint) {
      base.push(`${this.artistName} ${locationHint}`);
    }

    return Array.from(new Set(base));
  }

  private async crawlGoogle(queries: string[], bot: BotRecord): Promise<DiscoveryItem[]> {
    const items: DiscoveryItem[] = [];

    for (const query of queries.slice(0, 4)) {
      try {
        const searchUrl = new URL("https://www.googleapis.com/customsearch/v1");
        searchUrl.searchParams.set("key", process.env.GOOGLE_API_KEY!);
        searchUrl.searchParams.set("cx", process.env.GOOGLE_SEARCH_ENGINE_ID!);
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("num", "5");
        searchUrl.searchParams.set("dateRestrict", "d7");

        const response = await fetch(searchUrl.toString(), { headers: { Accept: "application/json" } });
        if (!response.ok) continue;

        const data = (await response.json()) as { items?: Array<{ link?: string; snippet?: string; title?: string }> };
        for (const item of data.items ?? []) {
          const title = item.title ?? "Latest Only1Marathon coverage";
          const description = item.snippet ?? title;
          if (!title) continue;
          // A missing link means there's no real page to attribute this to —
          // fabricating a google.com/search URL as the "source" used to get
          // screenshotted and posted as if it were real content. Skip instead.
          if (!item.link) continue;
          items.push({
            title,
            description,
            url: item.link,
            source: "Google Search",
            mediaType: this.detectMediaType(title, description),
            relevanceScore: this.scoreContent(title, description, bot.content_target),
            tags: this.extractTags(title, description, bot.content_target),
          });
        }
      } catch {
        // ignore provider errors and continue with other sources
      }
    }

    return items;
  }

  // Reddit meme sourcing removed: public .json endpoints return 403 from this environment.

  // Imgflip's /get_memes returns blank, uncaptioned templates (Drake Hotline Bling, etc.)
  // with zero embedded text — not usable as a discovery source, do not reintroduce.

  // 9gag was evaluated and rejected: it sits behind a Cloudflare JS challenge
  // ("Just a moment...") that returns 403 to any non-browser fetch, so it cannot
  // be crawled server-side. Do not reintroduce without a headless-browser solution.

  private readonly KAPWING_MEME_CATEGORIES = [
    "tv-and-movies",
    "drake",
    "reaction",
    "video",
    "simpsons",
    "breaking-bad",
  ];

  private async crawlKapwingMemes(): Promise<DiscoveryItem[]> {
    const items: DiscoveryItem[] = [];
    const seenSlugs = new Set<string>();
    // Matches template cards: <a title="X" ... href="/explore/slug"><img src="..."/></a>
    // or the video variant <a title="X" ... href="/explore/slug"><video src="..." poster="..."></video></a>
    const cardPattern =
      /<a title="([^"]+)"[^>]*href="(\/explore\/[a-z0-9-]+)"[^>]*>\s*(?:<img[^>]+src="([^"]+)"|<video[^>]+src="([^"]+)"[^>]+poster="([^"]+)")/gi;

    for (const category of this.KAPWING_MEME_CATEGORIES) {
      try {
        const response = await fetch(`https://www.kapwing.com/templates/memes/${category}`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html",
          },
        });
        if (!response.ok) continue;

        const html = await response.text();
        let match: RegExpExecArray | null;
        while ((match = cardPattern.exec(html))) {
          const [, title, slug, imgSrc, videoSrc] = match;
          if (seenSlugs.has(slug)) continue;
          seenSlugs.add(slug);

          // Kapwing's video template previews (unlike the image ones) bake in a
          // permanent "Finally being able to use a Kapwing project..." promo
          // caption across every frame of the clip — verified by sampling frames
          // at start/middle/end of several .mp4s. There's no reliable per-template
          // crop region to strip it, so video templates are excluded entirely to
          // avoid publishing Kapwing's own promo text. Only blank image templates
          // are used.
          if (videoSrc) continue;

          items.push({
            title,
            description: `${title} — free meme template (${category.replace(/-/g, " ")})`,
            url: `https://www.kapwing.com${slug}`,
            source: "Kapwing",
            mediaType: "image",
            relevanceScore: 55,
            tags: ["meme", "template", category],
            mediaUrl: imgSrc,
          });
        }
      } catch (error) {
        console.warn(`[content-discovery] Kapwing crawl failed for ${category}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return items;
  }

  private readonly IMGUR_MEME_TAGS = ["funny", "current_events", "movies", "dnd"];

  private async crawlImgurMemes(): Promise<DiscoveryItem[]> {
    const clientId = process.env.IMGUR_CLIENT_ID;
    if (!clientId) return [];

    const items: DiscoveryItem[] = [];
    const seenIds = new Set<string>();

    for (const tag of this.IMGUR_MEME_TAGS) {
      try {
        const response = await fetch(`https://api.imgur.com/3/gallery/t/${encodeURIComponent(tag)}/viral/0`, {
          headers: {
            Authorization: `Client-ID ${clientId}`,
            Accept: "application/json",
          },
        });
        if (!response.ok) continue;

        const data = (await response.json()) as {
          data?: {
            items?: Array<{
              id?: string;
              title?: string;
              description?: string | null;
              nsfw?: boolean;
              link?: string;
              mp4?: string;
              animated?: boolean;
              is_album?: boolean;
              images?: Array<{ link?: string; mp4?: string; animated?: boolean }>;
              tags?: Array<{ name?: string }>;
              ups?: number;
            }>;
          };
        };

        for (const post of data.data?.items ?? []) {
          if (!post.id || seenIds.has(post.id) || post.nsfw) continue;
          seenIds.add(post.id);

          const cover = post.is_album ? post.images?.[0] : post;
          const mediaUrl = cover?.mp4 || cover?.link;
          if (!mediaUrl) continue;

          const title = (post.title || "Imgur post").slice(0, 180);
          const description = (post.description || title).slice(0, 280);
          const isVideo = Boolean(cover?.mp4 || cover?.animated) && /\.(mp4|gifv)(\?|$)/i.test(mediaUrl);

          items.push({
            title,
            description,
            url: `https://imgur.com/gallery/${post.id}`,
            source: "Imgur",
            mediaType: isVideo ? "video" : "image",
            relevanceScore: Math.min(100, 55 + Math.min(20, Math.floor((post.ups ?? 0) / 200))),
            tags: Array.from(new Set(["meme", tag, ...(post.tags?.map((t) => t.name).filter((n): n is string => Boolean(n)) ?? [])])),
            mediaUrl: mediaUrl.replace(/\.gifv$/i, ".mp4"),
          });
        }
      } catch (error) {
        console.warn(`[content-discovery] Imgur crawl failed for tag ${tag}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return items;
  }

  private async crawlTikTokProfile(onBatch?: (items: DiscoveryItem[]) => void): Promise<DiscoveryItem[]> {
    // 15 was an arbitrary cap that cut off real uploads (the artist's
    // profile alone has 40+ clips) — raised well past that, and now also
    // crawls known fan/edit accounts in parallel for real depth.
    const handles = [this.tiktokHandle, ...TIKTOK_CURATED_FAN_HANDLES];
    const items: DiscoveryItem[] = [];

    const toDiscoveryItems = (handle: string, videos: Awaited<ReturnType<typeof extractTikTokProfileVideos>>) => {
      const isArtist = handle === this.tiktokHandle;
      return videos.map((video) => ({
        title: video.title || `${isArtist ? this.artistName : `@${handle}`} TikTok clip`,
        description: isArtist
          ? `Official ${this.artistName} TikTok video for fan engagement — ${video.title || video.id}`
          : `Fan-page TikTok video from @${handle} featuring ${this.artistName} — ${video.title || video.id}`,
        url: video.url,
        source: "TikTok",
        mediaType: "video" as const,
        // Ranked above generic search results — this is first-party artist
        // content straight from their own page, not a random search hit.
        relevanceScore: isArtist ? 92 : 85,
        tags: isArtist ? ["fan_engagement", "fan", "tiktok", "official"] : ["fan_engagement", "fan", "tiktok"],
        thumbnailUrl: video.thumbnailUrl,
      }));
    };

    await mapWithConcurrency(
      handles,
      4,
      (handle) => extractTikTokProfileVideos(handle, 50),
      (handle, result) => {
        if (result.status !== "fulfilled") return;
        const handleItems = toDiscoveryItems(handle, result.value);
        items.push(...handleItems);
        onBatch?.(handleItems);
      },
    );

    return items;
  }

  // The artist's own profile (crawlTikTokProfile) is a small fixed pool that
  // exhausts fast. This finds fan reaction/duet/mention videos instead, same
  // DuckDuckGo HTML-scrape pattern as Facebook/YouTube search below — gives
  // the "Live" tab real variety instead of the same ~15 clips every time.
  private async crawlTikTokFanSearch(onBatch?: (items: DiscoveryItem[]) => void): Promise<DiscoveryItem[]> {
    const videoUrlPattern = /tiktok\.com\/@[\w.-]+\/video\/(\d+)/i;
    const items: DiscoveryItem[] = [];
    const seen = new Set<string>();

    for (const query of [`site:tiktok.com "${this.artistName}"`, `site:tiktok.com "@${this.tiktokHandle}"`]) {
      const batch: DiscoveryItem[] = [];
      try {
        const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (!response.ok) continue;
        const html = await response.text();
        const matches = html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);

        for (const match of matches) {
          const href = match[1];
          const ddgMatch = href.match(/[?&]uddg=([^&]+)/);
          const decoded = ddgMatch ? decodeURIComponent(ddgMatch[1]) : href;
          if (!videoUrlPattern.test(decoded) || seen.has(decoded)) continue;
          seen.add(decoded);

          const title = this.stripHtml(match[2] ?? "").trim() || `${this.artistName} TikTok fan clip`;
          batch.push({
            title,
            description: `Fan TikTok video mentioning ${this.artistName} — ${title}`,
            url: decoded,
            source: "TikTok",
            mediaType: "video",
            relevanceScore: 80,
            tags: ["fan_engagement", "fan", "tiktok"],
          });
        }
      } catch {
        // A failed search query just means fewer candidates this run.
      }
      items.push(...batch);
      if (batch.length > 0) onBatch?.(batch);
    }

    return items;
  }

  // Facebook has no yt-dlp flat-playlist support (profile/reels index pages
  // return "Unsupported URL"), so real videos are found via search instead —
  // confirmed live that a specific facebook.com/<page>/videos/<id>/ or
  // /reel/<id> URL extracts a real .mp4 with no login required.
  private async crawlFacebookVideos(onBatch?: (items: DiscoveryItem[]) => void): Promise<DiscoveryItem[]> {
    const videoUrlPattern = /\/(videos|reel)\/([^/?]*\d)/i;
    const items: DiscoveryItem[] = [];
    const seen = new Set<string>();

    for (const query of [`site:facebook.com/${this.facebookHandle} reel`, `site:facebook.com/${this.facebookHandle} videos`]) {
      const batch: DiscoveryItem[] = [];
      try {
        const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (!response.ok) continue;
        const html = await response.text();
        const matches = html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);

        for (const match of matches) {
          const href = match[1];
          const ddgMatch = href.match(/[?&]uddg=([^&]+)/);
          const decoded = ddgMatch ? decodeURIComponent(ddgMatch[1]) : href;
          // Only specific video/reel URLs are real, individually downloadable
          // clips — bare profile/reels-index pages have nothing to extract.
          if (!videoUrlPattern.test(decoded) || seen.has(decoded)) continue;
          seen.add(decoded);

          const title = this.stripHtml(match[2] ?? "").trim() || `${this.artistName} Facebook video`;
          batch.push({
            title,
            description: `Official ${this.artistName} Facebook video for fan engagement — ${title}`,
            url: decoded,
            source: "Facebook",
            mediaType: "video",
            relevanceScore: 90,
            tags: ["fan_engagement", "fan", "facebook", "official"],
          });
        }
      } catch {
        // A failed search query just means fewer candidates this run.
      }
      items.push(...batch);
      if (batch.length > 0) onBatch?.(batch);
    }

    return items;
  }

  // Twitter/X has no anonymous scraping path (login-walled), so this relies
  // on an authenticated Playwright session using dashboard-uploaded cookies
  // (see discovery-media.ts's listRecentTweets). Only lists permalinks/text
  // here — the actual screenshot only happens for the one item the user
  // selects in the Live tab (extractMediaFromUrl's Twitter branch).
  private async crawlTwitterProfile(onBatch?: (items: DiscoveryItem[]) => void): Promise<DiscoveryItem[]> {
    const tweets = await listRecentTweets(this.twitterHandle, 20);
    const items: DiscoveryItem[] = tweets.map((tweet) => {
      const title = tweet.text.trim().slice(0, 120) || `${this.artistName} tweet`;
      return {
        title,
        description: tweet.text.trim() || title,
        url: tweet.url,
        source: "Twitter",
        mediaType: "social_post" as const,
        relevanceScore: 90,
        tags: ["fan_engagement", "twitter", "official"],
      };
    });

    if (items.length > 0) onBatch?.(items);
    return items;
  }

  // YouTube has no reliable flat-playlist/channel-listing support here (the
  // @handle/videos channel page itself repeatedly fails yt-dlp extraction —
  // it's not a single video), so candidates are found via search instead,
  // same DuckDuckGo HTML-scrape pattern as Facebook. Per-item extraction is
  // still attempted later and frequently fails/gets skipped — that's
  // surfaced to the user rather than hidden.
  private async crawlYouTubeSearch(onBatch?: (items: DiscoveryItem[]) => void): Promise<DiscoveryItem[]> {
    const videoUrlPattern = /youtube\.com\/watch\?v=([\w-]{6,})/i;
    const items: DiscoveryItem[] = [];
    const seen = new Set<string>();

    for (const query of [`site:youtube.com/watch ${this.artistName}`, `"${this.youtubeHandle}" youtube`]) {
      const batch: DiscoveryItem[] = [];
      try {
        const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (!response.ok) continue;
        const html = await response.text();
        const matches = html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);

        for (const match of matches) {
          const href = match[1];
          const ddgMatch = href.match(/[?&]uddg=([^&]+)/);
          const decoded = ddgMatch ? decodeURIComponent(ddgMatch[1]) : href;
          if (!videoUrlPattern.test(decoded) || seen.has(decoded)) continue;
          seen.add(decoded);

          const title = this.stripHtml(match[2] ?? "").trim() || `${this.artistName} YouTube video`;
          batch.push({
            title,
            description: `Official ${this.artistName} YouTube video for fan engagement — ${title}`,
            url: decoded,
            source: "YouTube",
            mediaType: "video",
            relevanceScore: 88,
            tags: ["fan_engagement", "fan", "youtube", "official"],
          });
        }
      } catch {
        // A failed search query just means fewer candidates this run.
      }
      items.push(...batch);
      if (batch.length > 0) onBatch?.(batch);
    }

    return items;
  }

  private async crawlWikipedia(): Promise<DiscoveryItem[]> {
    try {
      const response = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(this.artistName)}&prop=extracts&exintro=1&explaintext=1&format=json`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) return [];
      const data = (await response.json()) as { query?: { pages?: Record<string, { extract?: string; title?: string }> } };
      const pages = data.query?.pages ?? {};
      const page = Object.values(pages)[0];
      if (!page?.extract) return [];
      return [
        {
          title: `Biography / background: ${page.title ?? this.artistName}`,
          description: page.extract.slice(0, 280),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(this.artistName)}`,
          source: "Wikipedia",
          mediaType: "article",
          relevanceScore: 78,
          tags: ["biography", "artist", "afrobeats"],
        },
      ];
    } catch {
      return [];
    }
  }

  private async crawlGenericWeb(queries: string[], bot: BotRecord): Promise<DiscoveryItem[]> {
    const items: DiscoveryItem[] = [];
    for (const query of queries.slice(0, 3)) {
      try {
        const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (!response.ok) continue;
        const html = await response.text();
        const matches = html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);
        let count = 0;
        for (const match of matches) {
          const href = match[1];
          const title = this.stripHtml(match[2] ?? "").trim();
          if (!title || count >= 3) break;
          if (this.isProfileOrChannelRootUrl(href)) continue;
          const description = `${title} — ${query}`;
          items.push({
            title,
            description,
            url: href,
            source: "DuckDuckGo",
            mediaType: this.detectMediaType(title, description),
            relevanceScore: this.scoreContent(title, description, bot.content_target),
            tags: this.extractTags(title, description, bot.content_target),
          });
          count += 1;
        }
      } catch {
        // ignore fallback errors
      }
    }
    return items;
  }

  private rankForTarget(items: DiscoveryItem[], bot: BotRecord): DiscoveryItem[] {
    const semanticTerms = this.buildSemanticTerms(bot);

    return items
      .map((item) => {
        // MemeVault items already arrive in a deliberate round-robin/video-ratio
        // order with a strictly decreasing relevanceScore — re-scoring them by
        // text-signal heuristics here would scramble that order.
        if (item.source === "MemeVault") return item;

        const text = `${item.title} ${item.description} ${item.contextHint ?? ""}`.toLowerCase();
        const normalizedText = this.normalizeText(text);
        let score = item.relevanceScore;

        if (bot.content_target === "memes") {
          if (/screenshot|text|tweet|meme|joke|reaction|viral|bro|lmao|what|no way|😂|💀/i.test(text)) score += 12;
          if (item.source.toLowerCase().includes("reddit")) score += 4;
          if (item.source.toLowerCase().includes("twitter") || item.source.toLowerCase().includes("x")) score += 6;
          if (item.mediaType === "image") score += 4;
          if (item.contextHint) score += 4;

          const matchedTerms = semanticTerms.filter((term) => this.normalizeText(term).length > 0 && normalizedText.includes(this.normalizeText(term)));
          score += matchedTerms.length * 6;

          if (this.isSpecificMemeCandidate(item)) score += 8;
          if (this.isGenericMemeCandidate(item)) score -= 10;
        }

        return { ...item, relevanceScore: Math.min(100, Math.max(0, score)) };
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private async crawlRedditVideos(bot: BotRecord): Promise<DiscoveryItem[]> {
    const targets = ["afrobeats", "Music", "ViralVideos", "cars", "motorcycles"];
    const queryTerms = [
      this.artistName,
      this.artistHandle,
      "afrobeats",
      "viral",
      bot.content_target.replace(/_/g, " "),
    ]
      .filter(Boolean)
      .join(" OR ");

    const collected: DiscoveryItem[] = [];

    for (const subreddit of targets) {
      try {
        const searchUrl = new URL(`https://www.reddit.com/r/${subreddit}/search.json`);
        searchUrl.searchParams.set("q", queryTerms);
        searchUrl.searchParams.set("restrict_sr", "1");
        searchUrl.searchParams.set("sort", "new");
        searchUrl.searchParams.set("limit", "15");

        const response = await fetch(searchUrl.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": "only1marathon-bot/1.0",
          },
        });

        if (!response.ok) continue;
        const data = (await response.json()) as {
          data?: {
            children?: Array<{
              data?: {
                id?: string;
                title?: string;
                selftext?: string;
                permalink?: string;
                score?: number;
                is_video?: boolean;
                media?: {
                  reddit_video?: {
                    fallback_url?: string;
                  };
                };
                url_overridden_by_dest?: string;
              };
            }>;
          };
        };

        for (const child of data.data?.children ?? []) {
          const post = child.data;
          if (!post) continue;

          const mediaUrl = post.media?.reddit_video?.fallback_url ?? post.url_overridden_by_dest;
          if (!mediaUrl || !/\.mp4(\?|$)/i.test(mediaUrl)) continue;

          const title = (post.title ?? "Viral video clip").slice(0, 180);
          const description = (post.selftext ?? title).slice(0, 280);
          collected.push({
            title,
            description,
            url: post.permalink ? `https://reddit.com${post.permalink}` : mediaUrl,
            source: `Reddit r/${subreddit}`,
            mediaType: "video",
            relevanceScore: Math.min(
              100,
              this.scoreContent(title, description, bot.content_target) + Math.min(20, Math.floor((post.score ?? 0) / 100)),
            ),
            tags: Array.from(new Set(["reddit", "video", "viral", ...this.extractTags(title, description, bot.content_target)])),
            mediaUrl,
          });
        }
      } catch {
        // ignore reddit failures and continue with other sources
      }
    }

    return collected;
  }

  private async enrichWithMedia(items: DiscoveryItem[]): Promise<DiscoveryItem[]> {
    const results: DiscoveryItem[] = [];
    for (const item of items) {
      const clone: DiscoveryItem = { ...item };
      try {
        const fetched = await this.tryFetchMedia(item.url, item.mediaType);
        if (fetched) clone.mediaUrl = fetched;
      } catch {
        // ignore media download failures and continue
      }
      results.push(clone);
    }
    return results;
  }

  private async tryFetchMedia(url: string, mediaType: DiscoveryItem["mediaType"]): Promise<string | undefined> {
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    if (mediaType !== "video" && mediaType !== "image" && mediaType !== "social_post") {
      return undefined;
    }

    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.startsWith("image/")) {
        return response.url;
      }
      if (contentType.startsWith("video/")) {
        return response.url;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private deduplicate(items: DiscoveryItem[]): DiscoveryItem[] {
    const seen = new Set<string>();
    const accepted: DiscoveryItem[] = [];

    for (const item of items) {
      const key = `${item.source}:${item.url}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const duplicate = accepted.find((existing) => this.isNearDuplicate(existing, item));
      if (duplicate) {
        if (item.relevanceScore > duplicate.relevanceScore) {
          const index = accepted.indexOf(duplicate);
          accepted[index] = item;
        }
        continue;
      }

      accepted.push(item);
    }

    return accepted;
  }

  private isNearDuplicate(left: DiscoveryItem, right: DiscoveryItem): boolean {
    const leftTokens = this.getMeaningfulTokens(left.title, left.description, left.tags);
    const rightTokens = this.getMeaningfulTokens(right.title, right.description, right.tags);

    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return left.title.toLowerCase() === right.title.toLowerCase() || left.url === right.url;
    }

    const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const similarity = union === 0 ? 0 : overlap / union;

    return similarity >= 0.45 || (left.source === right.source && left.title.toLowerCase() === right.title.toLowerCase());
  }

  private getMeaningfulTokens(title: string, description: string, tags: string[]): Set<string> {
    const tokens = new Set<string>();
    const text = `${title} ${description} ${tags.join(" ")}`.toLowerCase();
    const normalized = this.normalizeText(text);
    const parts = normalized.split(/\s+/).filter(Boolean);

    for (const part of parts) {
      if (part.length < 3) continue;
      if (this.GENERIC_STOP_WORDS.has(part)) continue;
      tokens.add(part);
    }

    return tokens;
  }

  private readonly GENERIC_STOP_WORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "your",
    "you",
    "are",
    "was",
    "were",
    "have",
    "has",
    "will",
    "can",
    "but",
    "about",
    "on",
    "in",
    "of",
    "to",
    "a",
    "an",
    "or",
    "is",
    "be",
    "it",
    "as",
    "at",
    "by",
    "our",
    "more",
    "than",
    "then",
    "some",
    "all",
    "just",
    "very",
    "official",
    "video",
    "post",
    "posts",
    "new",
    "latest",
    "top",
    "viral",
    "meme",
    "funny",
    "reaction",
  ]);

  private buildSemanticTerms(bot: BotRecord): string[] {
    const terms = [this.artistName, this.artistHandle, ...this.songs].filter(Boolean);
    if (bot.city) terms.push(bot.city);
    if (bot.country) terms.push(bot.country);
    if (bot.content_target === "memes") {
      terms.push("afrobeats", "music", "screenshot", "tweet", "street", "cars", "motorcycle", "movie", "lyric", "official");
    }
    return Array.from(new Set(terms));
  }

  private isSpecificMemeCandidate(item: DiscoveryItem): boolean {
    const text = `${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
    const signalTerms = ["only1marathon", "afrobeats", "song", "lyric", "official", "street", "cars", "motorcycle", "reaction", "screenshot", "tweet"];
    return signalTerms.filter((term) => text.includes(term)).length >= 2;
  }

  private isGenericMemeCandidate(item: DiscoveryItem): boolean {
    const text = `${item.title} ${item.description}`.toLowerCase();
    return /^(?:meme|funny|viral|reaction)$/i.test(text.trim()) || (!/only1marathon|afrobeats|song|lyric|official|street|cars|motorcycle|reaction|screenshot|tweet/i.test(text) && /meme|funny|viral|reaction/i.test(text));
  }

  private normalizeText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  private scoreContent(title: string, description: string, contentTarget?: string): number {
    const text = `${title} ${description}`.toLowerCase();
    let score = 35;
    if (text.includes(this.artistName.toLowerCase())) score += 25;
    if (this.songs.some((song) => text.includes(song.toLowerCase()))) score += 15;
    if (text.includes("afrobeats")) score += 10;
    if (text.includes("interview")) score += 10;
    if (text.includes("performance")) score += 10;
    if (text.includes("news")) score += 8;
    if (text.includes("release")) score += 8;
    if (text.includes("video")) score += 7;
    if (text.includes("music")) score += 5;

    if (contentTarget === "memes") {
      if (text.includes("meme")) score += 18;
      if (text.includes("funny") || text.includes("reaction")) score += 12;
      if (text.includes("movie") || text.includes("scene") || text.includes("cars") || text.includes("motorcycle")) score += 10;
    }

    if (contentTarget === "viral_trends") {
      if (text.includes("viral") || text.includes("trend") || text.includes("trending")) score += 15;
    }

    return Math.min(100, score);
  }

  private extractTags(title: string, description: string, contentTarget?: string): string[] {
    const text = `${title} ${description}`.toLowerCase();
    // Do NOT unconditionally tag every item "only1marathon" — that made the
    // artist-relevance guard in content-guard.ts tautological (anything
    // discovered here would "pass" purely because of this tag, regardless of
    // whether the actual content had anything to do with the artist). Check
    // ONLY the title — description here is `${title} — ${searchQuery}` and
    // the query always contains the artist's name, so checking description
    // would still make this unconditional in practice.
    const tags = ["afrobeats"];
    if (title.toLowerCase().includes(this.artistName.toLowerCase())) tags.push("only1marathon");
    if (text.includes("interview")) tags.push("interview");
    if (text.includes("performance")) tags.push("performance");
    if (text.includes("video")) tags.push("music-video");
    if (text.includes("news")) tags.push("news");
    this.songs.forEach((song) => {
      if (text.includes(song.toLowerCase())) tags.push(song.toLowerCase().replace(/ /g, "_"));
    });

    if (contentTarget === "memes") {
      tags.push("meme", "viral", "funny", "reaction");
      if (text.includes("car")) tags.push("cars");
      if (text.includes("motorcycle") || text.includes("bike")) tags.push("bikes");
      if (text.includes("movie")) tags.push("movie_clips");
    }

    return Array.from(new Set(tags));
  }

  private detectMediaType(title: string, description: string): DiscoveryItem["mediaType"] {
    const text = `${title} ${description}`.toLowerCase();
    if (text.includes("video") || text.includes("watch")) return "video";
    if (text.includes("interview")) return "interview";
    if (text.includes("news") || text.includes("article")) return "news";
    if (text.includes("instagram") || text.includes("post")) return "social_post";
    return "article";
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
}
