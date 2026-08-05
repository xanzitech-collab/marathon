export const PERSONA_OPTIONS = [
  { value: "afrobeats_hype_editor", label: "Afrobeats Hype Editor" },
  { value: "street_culture_curator", label: "Street Culture Curator" },
  { value: "fan_community_voice", label: "Fan Community Voice" },
  { value: "release_countdown_host", label: "Release Countdown Host" },
];

export const CONTENT_TARGET_OPTIONS = [
  { value: "fan_engagement", label: "Fan Engagement" },
  { value: "release_promo", label: "Release Promotion" },
  { value: "behind_the_scenes", label: "Behind The Scenes" },
  { value: "lifestyle_vibes", label: "Lifestyle Vibes" },
  { value: "memes", label: "Memes" },
  { value: "viral_trends", label: "Viral Trends" },
  { value: "song_snippets", label: "Song Snippets" },
  { value: "fan_reactions", label: "Fan Reactions" },
  { value: "tour_hype", label: "Tour Hype" },
  { value: "challenge_campaign", label: "Challenge Campaign" },
  { value: "community_questions", label: "Community Questions" },
  { value: "new_release_countdown", label: "New Release Countdown" },
  { value: "music_facts", label: "Music Facts" },
  { value: "throwback_moments", label: "Throwback Moments" },
];

export const FREQUENCY_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "every_n_days", label: "Every N Days" },
  { value: "weekdays_only", label: "Weekdays Only" },
] as const;

export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

export const HARD_MAX_POSTS_PER_DAY = Number(process.env.HARD_MAX_POSTS_PER_DAY ?? 25);

export function getApiKeysBySlot(slot: number) {
  if (slot < 1 || slot > 5) {
    throw new Error("Slot out of range. Expected 1..5");
  }

  const xenrio = process.env[`XENRIO_API_KEY_${slot}`];
  const gemini = process.env[`GEMINI_API_KEY_${slot}`];

  if (!xenrio || !gemini) {
    throw new Error(`Missing API key(s) for slot ${slot}`);
  }

  return { xenrio, gemini };
}

// The free Gemini tier's quota (20 requests) is exhausted easily by a single
// busy channel. Rather than falling back to canned captions the moment a
// bot's own slot key is tapped out, give it every other configured key to
// try first — most slots aren't being hammered at the same time.
export function getGeminiKeysForBot(slot: number): string[] {
  const ownKey = process.env[`GEMINI_API_KEY_${slot}`];
  const allKeys = [1, 2, 3, 4, 5]
    .map((s) => process.env[`GEMINI_API_KEY_${s}`])
    .filter((key): key is string => Boolean(key));

  const ordered = ownKey ? [ownKey, ...allKeys.filter((key) => key !== ownKey)] : allKeys;
  return Array.from(new Set(ordered));
}
