import { ARTIST_CONTEXT } from "@/lib/artist";

interface FocusInput {
  title?: string | null;
  description?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  tags?: string[] | null;
}

const WRAPPER_HOST_PATTERNS = [
  "tenor.com",
  "giphy.com",
];

// Once extractMediaFromUrl has already resolved real media (a video, a
// thumbnail, or a screenshot fallback), that result naturally still contains
// the original page's domain as a substring (e.g. a screenshot URL embeds the
// tiktok.com page it captured) — checking it against the same patterns used
// to skip un-extracted wrapper pages would wrongly reject legitimate resolved
// media. Only tenor/giphy (whose own og:image is never real content) still
// apply post-extraction.
const POST_EXTRACTION_WRAPPER_PATTERNS = ["tenor.com", "giphy.com"];

function normalizeText(input: FocusInput): string {
  return [
    input.title ?? "",
    input.description ?? "",
    input.source ?? "",
    input.sourceUrl ?? "",
    ...(input.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

// Only genuine external signals — never `description`, which some crawlers
// (crawlGenericWeb) construct as `${title} — ${searchQuery}`, and the search
// query always contains the artist's name. Using it here made the check
// tautological: a runner's Snapchat post or an unrelated Dutch podcast about
// literal marathon running both "passed" simply because our own query text
// got echoed into their description, not because the content was relevant.
function restrictedRelevanceText(input: FocusInput): string {
  return [input.title ?? "", input.sourceUrl ?? "", ...(input.tags ?? [])].join(" ").toLowerCase();
}

function keywordScore(text: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}

function isAboutArtist(normalizedText: string): boolean {
  // Single common-word song titles ("Dnd", "Tonight") are excluded — they'd
  // match all sorts of unrelated text and defeat the point of this check.
  const songSignals = ARTIST_CONTEXT.songs.filter((song) => song.trim().includes(" "));
  const signals = [ARTIST_CONTEXT.name, ARTIST_CONTEXT.instagramHandle, ARTIST_CONTEXT.tiktokHandle, ...songSignals]
    .filter(Boolean)
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""));

  const compactText = normalizedText.replace(/[^a-z0-9]/g, "");
  return signals.some((signal) => signal.length > 0 && compactText.includes(signal));
}

export function isKnownWrapperSource(url: string | null | undefined): boolean {
  if (!url) return false;
  const value = url.toLowerCase();
  return WRAPPER_HOST_PATTERNS.some((pattern) => value.includes(pattern));
}

export function isKnownWrapperMediaResult(url: string | null | undefined): boolean {
  if (!url) return false;
  const value = url.toLowerCase();
  return POST_EXTRACTION_WRAPPER_PATTERNS.some((pattern) => value.includes(pattern));
}

export function isFocusAligned(contentTarget: string, input: FocusInput): boolean {
  const text = normalizeText(input);

  if (contentTarget === "memes") {
    const must = ["meme", "funny", "reaction", "viral", "template", "joke", "movie", "cars", "motorcycle", "bike"];
    return keywordScore(text, must) >= 1;
  }

  // The artist's name ("Only1Marathon") collides with the common English word
  // "marathon" (running races) — without this, generic searches happily surface
  // real marathon-running content that has nothing to do with the artist, and
  // it slips through target-specific keyword checks (a race recap can easily
  // mention "fans"). Every non-meme target must actually reference the artist.
  if (!isAboutArtist(restrictedRelevanceText(input))) {
    return false;
  }

  if (contentTarget === "viral_trends") {
    const must = ["viral", "trend", "trending", "challenge", "reel", "short"];
    return keywordScore(text, must) >= 1;
  }

  if (contentTarget === "song_snippets") {
    const must = ["song", "snippet", "audio", "lyrics", "music", "studio", "recording"];
    return keywordScore(text, must) >= 1;
  }

  if (contentTarget === "fan_reactions") {
    const must = ["reaction", "fans", "fan", "comment", "response", "duet"];
    return keywordScore(text, must) >= 1;
  }

  return true;
}
