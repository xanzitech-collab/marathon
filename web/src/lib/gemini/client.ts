export interface CaptionInput {
  artist: string;
  songs: string[];
  persona: string;
  additionalPersona?: string | null;
  contentTarget: string;
  location?: string;
  mediaTags?: string[];
  sourceContext?: string | null; // title/description of the specific content item
}

export interface VideoContextInput {
  transcript: string;
  keyframeBase64: string[];
  persona: string;
  additionalPersona?: string | null;
  contentTarget: string;
  location?: string;
  songs: string[];
  artistHandle: string;
}

export interface VideoContextResult {
  hasBurnedInText: boolean;
  contextSummary: string;
  igCaption: string;
  hashtags: string[];
  needsManualReview: boolean;
}

export interface MemeImageAnalysisInput {
  imageBase64: string;
  mimeType: string;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  mediaTags?: string[];
}

export interface MemeImageAnalysisResult {
  hasReadableText: boolean;
  extractedText: string;
  isMeme: boolean;
  confidence: number;
  visualContext: string;
  suggestedOverlayText: string;
  suggestedCaption: string;
  hashtags: string[];
}

export interface MissionPlan {
  persona: string;
  additionalPersona: string;
  contentTarget: string;
  customTargetPrompt: string;
}

interface CaptionStyle {
  instruction: string;
  hashtagRule: string;
}

// Real people don't post the same length/shape caption every time. Picking a
// different archetype per call is what actually produces variety — asking
// the model to "vary it" in a static prompt barely changes the output.
function pickCaptionStyle(memeMode: boolean): CaptionStyle {
  const styles: CaptionStyle[] = [
    {
      instruction: "Length/style: just one short punchy line. That's it, don't pad it out.",
      hashtagRule: "0 to 2 hashtags, or none at all.",
    },
    {
      instruction: "Length/style: two to three short lines, like a quick text to a friend, mild dry humor.",
      hashtagRule: "3 to 6 hashtags.",
    },
    {
      instruction: "Length/style: a short mini-story, 2-3 sentences, conversational, slightly rambling like a real thought.",
      hashtagRule: "5 to 9 hashtags.",
    },
    {
      instruction: "Length/style: open with a callout or aside (not necessarily a question), then one more short line.",
      hashtagRule: "2 to 5 hashtags.",
    },
    {
      instruction: "Length/style: deadpan one-liner, dry and understated, no exclamation points.",
      hashtagRule: "1 to 3 hashtags.",
    },
    {
      instruction: "Length/style: slightly longer, enthusiastic run-on energy, like you're excited and typing fast.",
      hashtagRule: memeMode ? "6 to 10 hashtags." : "8 to 14 hashtags.",
    },
  ];

  return styles[Math.floor(Math.random() * styles.length)];
}

// Used when Gemini errors out or returns nothing (e.g. free-tier quota hit —
// which happens often). A single hardcoded fallback would mean every post
// during an outage gets the exact same caption; pick randomly from a pool and
// a random song instead so repeated fallbacks still look distinct.
function pickFallbackCaption(memeMode: boolean, songs: string[]): string {
  if (memeMode) {
    const memeFallbacks = [
      "lol okay this one's real.\n\n#relatable #mood",
      "not me finding this at 1am\n\n#toorela #mood",
      "this is way too accurate\n\n#mood #relatable",
      "okay who told them to post this\n\n#lol #mood",
      "waited all day to post this one\n\n#relatable",
    ];
    return memeFallbacks[Math.floor(Math.random() * memeFallbacks.length)];
  }

  const song = songs[Math.floor(Math.random() * songs.length)] ?? songs[0];
  const nonMemeFallbacks = [
    `${song} has been stuck in my head all day, not mad about it.\n\n#Only1Marathon #Afrobeats`,
    `still running ${song} back today, no notes.\n\n#Only1Marathon #Afrobeats`,
    `${song} hits different today ngl.\n\n#Only1Marathon #Afrobeats`,
    `can't stop playing ${song}, that's just facts.\n\n#Only1Marathon #Afrobeats`,
    `Only1Marathon on repeat today, no notes.\n\n#Only1Marathon #Afrobeats`,
  ];
  return nonMemeFallbacks[Math.floor(Math.random() * nonMemeFallbacks.length)];
}

export class GeminiClient {
  private readonly apiKeys: string[];

  constructor(apiKey: string | string[]) {
    this.apiKeys = Array.isArray(apiKey) ? apiKey : [apiKey];
  }

  private async generateText(model: string, parts: Array<Record<string, unknown>>, temperature?: number): Promise<string> {
    let lastError: unknown = null;

    for (const key of this.apiKeys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              ...(temperature !== undefined ? { generationConfig: { temperature } } : {}),
            }),
          },
        );

        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          lastError = new Error(`Gemini request failed (${res.status}): ${bodyText.slice(0, 500)}`);
          // Quota exhaustion is per-key — try the next configured key instead of
          // giving up immediately. Other error codes are probably not key-specific,
          // but trying the next key costs little and can still recover the post.
          continue;
        }

        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Gemini request failed on all configured keys");
  }

  async generateMissionPlan(input: { missionText: string; persona: string; contentTarget: string; location?: string }): Promise<MissionPlan> {
    const prompt = [
      "Turn the following creator mission into a concise bot strategy.",
      `Mission: ${input.missionText}`,
      `Current persona: ${input.persona}`,
      `Content target: ${input.contentTarget}`,
      input.location ? `Location: ${input.location}` : "",
      "Return JSON with persona, additionalPersona, contentTarget, customTargetPrompt.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const text = await this.generateText("gemini-flash-latest", [{ text: prompt }]);
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Partial<MissionPlan>;
      return {
        persona: parsed.persona ?? input.persona,
        additionalPersona: parsed.additionalPersona ?? "Build content that feels natural, personal, and conversion-oriented.",
        contentTarget: parsed.contentTarget ?? input.contentTarget,
        customTargetPrompt: parsed.customTargetPrompt ?? input.missionText,
      };
    } catch {
      return {
        persona: input.persona,
        additionalPersona: "Create content that feels personal, useful, and consistent with the creator’s mission.",
        contentTarget: input.contentTarget,
        customTargetPrompt: input.missionText,
      };
    }
  }

  async generateCaption(input: CaptionInput): Promise<string> {
    const model = "gemini-flash-latest";
    const memeMode = input.contentTarget === "memes";
    const style = pickCaptionStyle(memeMode);

    const prompt = [
      memeMode
        ? "Create an Instagram caption for a meme post."
        : `Create an Instagram caption for ${input.artist}.`,
      `Persona: ${input.persona}.`,
      input.additionalPersona ? `Additional persona: ${input.additionalPersona}.` : "",
      input.location ? `Location context: ${input.location}.` : "",
      input.mediaTags?.length ? `Media tags: ${input.mediaTags.join(", ")}.` : "",
      memeMode
        ? "Meme mode rules: internet humor, treat the image as the main joke, react to it like a real person would, not a brand. If the image contains readable text, react to that exact line or situation. Do not mention any artist, song, album, rollout, stream, brand, promo, or handle."
        : `Songs to reference naturally (only if it fits, don't force it every time): ${input.songs.join(", ")}.`,
      input.sourceContext
        ? memeMode
          ? `Visual evidence to use: ${input.sourceContext}`
          : `Post context (make the caption specific to THIS post, not generic): ${input.sourceContext}`
        : "",
      // Human-voice guardrails: this is the actual fix for "sounds too AI".
      "Write like a real person posting from their phone, not a marketing team or an AI assistant. Use contractions, casual grammar, sentence fragments where natural. It's fine to start lowercase, trail off, or not perfectly resolve a thought.",
      "Avoid AI-caption tells: no 'elevate', 'vibe check', 'let's dive in', 'unleash', 'game-changer', no forced alliteration, no rule-of-three lists, don't end every caption with a question or a call to action — most real posts don't have one.",
      style.instruction,
      memeMode
        ? "Never copy the source title, URL, or metadata into the caption."
        : "Rules: authentic tone, fan-first language, no corporate voice.",
      memeMode
        ? `Hashtag rules: ${style.hashtagRule} Only topical meme/reaction hashtags — never artist tags or promo tags.`
        : `Hashtag rules: ${style.hashtagRule} Mix artist tags with topical tags when you do use them.`,
      `Hard limit: max 2200 characters total.`,
    ]
      .filter(Boolean)
      .join("\n");

    let text = "";
    try {
      text = await this.generateText(model, [{ text: prompt }], 1.15);
    } catch (error) {
      console.error(`[gemini] generateCaption failed: ${error instanceof Error ? error.message : String(error)}`);
      return pickFallbackCaption(memeMode, input.songs);
    }

    if (!text) {
      return pickFallbackCaption(memeMode, input.songs);
    }

    return text.slice(0, 2200);
  }

  async transcribeAudioBase64(audioBase64: string, mimeType = "audio/mpeg"): Promise<string> {
    const prompt =
      "Transcribe this audio exactly. Return only the spoken transcript text. If speech is unclear, return your best short approximation.";
    try {
      const text = await this.generateText("gemini-flash-latest", [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: audioBase64,
          },
        },
      ]);
      return text.trim();
    } catch (error) {
      console.error(`[gemini] transcribeAudioBase64 failed: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  async analyzeVideoContext(input: VideoContextInput): Promise<VideoContextResult> {
    const prompt = [
      "Analyze these keyframes and transcript from a short video clip.",
      `Persona: ${input.persona}`,
      input.additionalPersona ? `Additional persona: ${input.additionalPersona}` : "",
      `Target: ${input.contentTarget}`,
      input.location ? `Location context: ${input.location}` : "",
      `Artist handle to promote naturally: @${input.artistHandle.replace(/^@/, "")}`,
      `Songs to reference naturally: ${input.songs.join(", ")}`,
      `Transcript: ${input.transcript || "(No reliable speech transcript available)"}`,
      "Return strict JSON with keys: has_burned_in_text (boolean), context_summary (string), ig_caption (string), hashtags (string array of 12-20), needs_manual_review (boolean).",
      "Caption rules: authentic, context-aware, do not invent facts, include one CTA, max 2200 chars.",
    ]
      .filter(Boolean)
      .join("\n");

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const frame of input.keyframeBase64.slice(0, 4)) {
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: frame,
        },
      });
    }

    try {
      const text = await this.generateText("gemini-flash-latest", parts);
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
        has_burned_in_text?: boolean;
        context_summary?: string;
        ig_caption?: string;
        hashtags?: string[];
        needs_manual_review?: boolean;
      };

      const hashtags = Array.isArray(parsed.hashtags)
        ? parsed.hashtags.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : [];

      return {
        hasBurnedInText: Boolean(parsed.has_burned_in_text),
        contextSummary: parsed.context_summary?.trim() || "Short-form video clip with dynamic visual context.",
        igCaption: (parsed.ig_caption?.trim() || "")
          .replace(/\s+/g, " ")
          .slice(0, 2200),
        hashtags,
        needsManualReview: Boolean(parsed.needs_manual_review),
      };
    } catch (error) {
      console.error(`[gemini] analyzeVideoContext failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        hasBurnedInText: false,
        contextSummary: "Video context could not be analyzed reliably.",
        igCaption:
          "Motion, mood, and energy in one reel. Tap in and tell us what hit you first. @only1marathon #Only1Marathon #Afrobeats #Reels",
        hashtags: [
          "#Only1Marathon",
          "#Afrobeats",
          "#Reels",
          "#ViralReels",
          "#MusicCulture",
          "#StreetVibes",
        ],
        needsManualReview: true,
      };
    }
  }

  async analyzeMemeImage(input: MemeImageAnalysisInput): Promise<MemeImageAnalysisResult> {
    const prompt = [
      "Analyze this image for meme publishing.",
      input.sourceTitle ? `Source title: ${input.sourceTitle}` : "",
      input.sourceDescription ? `Source description: ${input.sourceDescription}` : "",
      input.mediaTags?.length ? `Source tags: ${input.mediaTags.join(", ")}` : "",
      "Return strict JSON with keys: has_readable_text (boolean), extracted_text (string), is_meme (boolean), confidence (number 0 to 1), visual_context (string), suggested_overlay_text (string), suggested_caption (string), hashtags (string array).",
      "Rules:",
      "- Detect readable text in any language.",
      "- extracted_text must contain the exact readable text you can see, or an empty string if none is readable.",
      "- is_meme should be true only if the image already reads as a meme/reaction post or can clearly support meme formatting.",
      "- suggested_overlay_text must be a short punchline or setup, max 14 words, suitable to burn into the image if text is missing or weak.",
      "- suggested_caption must be a non-promotional Instagram caption for the meme, 1-3 short lines plus 8-14 topical hashtags.",
      "- Do not mention any artist, song, album, stream, rollout, brand, or promotion.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const text = await this.generateText("gemini-flash-latest", [
        { text: prompt },
        {
          inline_data: {
            mime_type: input.mimeType,
            data: input.imageBase64,
          },
        },
      ]);

      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
        has_readable_text?: boolean;
        extracted_text?: string;
        is_meme?: boolean;
        confidence?: number;
        visual_context?: string;
        suggested_overlay_text?: string;
        suggested_caption?: string;
        hashtags?: string[];
      };

      const hashtags = Array.isArray(parsed.hashtags)
        ? parsed.hashtags.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : [];

      return {
        hasReadableText: Boolean(parsed.has_readable_text),
        extractedText: parsed.extracted_text?.trim() || "",
        isMeme: Boolean(parsed.is_meme),
        confidence:
          typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0,
        visualContext: parsed.visual_context?.trim() || "",
        suggestedOverlayText: parsed.suggested_overlay_text?.trim() || "",
        suggestedCaption: (parsed.suggested_caption?.trim() || "").slice(0, 2200),
        hashtags,
      };
    } catch (error) {
      console.error(`[gemini] analyzeMemeImage failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        hasReadableText: false,
        extractedText: "",
        isMeme: false,
        confidence: 0,
        visualContext: "",
        suggestedOverlayText: "This is exactly how it started",
        suggestedCaption:
          "This escalated faster than expected.\n\nWho sent this energy into the timeline?\n\n#Meme #Relatable #FunnyPost #ReactionImage #TimelineMood #InternetHumor #TooReal #DailyMeme #NoContext",
        hashtags: [
          "#Meme",
          "#Relatable",
          "#FunnyPost",
          "#ReactionImage",
          "#InternetHumor",
          "#TooReal",
          "#DailyMeme",
          "#NoContext",
        ],
      };
    }
  }
}
