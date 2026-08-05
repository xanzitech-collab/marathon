export interface MemeVerificationResult {
  accepted: boolean;
  reason: string;
  hasReadableText: boolean;
  extractedText: string | null;
  contextDescription: string | null;
  suggestedJoke: string | null;
  qualityFlag: "good" | "low_res" | "watermarked" | "outdated_format";
}

export interface MemeVerificationInput {
  imageBase64: string;
  mimeType: string;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  mediaTags?: string[];
  // Kapwing video templates bake in a fixed promo caption on every frame —
  // this tells the model (and post-processing) to disregard it entirely.
  ignoreExistingText?: boolean;
  // All Gemini keys available to the calling bot, tried in order — a single
  // hardcoded key exhausts its free-tier quota after ~20 requests and used to
  // abort the ENTIRE discovery run (see the "verification_error" -> break
  // logic in discovery-ingest.ts) even though 3 other configured keys were
  // sitting unused. Falls back to the old single-key behavior if omitted.
  apiKeys?: string[];
}

export interface MemeFallbackPlan {
  proceed: boolean;
  captionContext: string | null;
  renderText: string | null;
}

export function buildFallbackMemePlan(input: {
  verificationResult: MemeVerificationResult | null;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  mediaTags?: string[];
}): MemeFallbackPlan {
  const contextBits = [
    input.sourceTitle?.trim(),
    input.sourceDescription?.trim(),
    input.mediaTags?.filter(Boolean).slice(0, 4).join(", "),
  ].filter(Boolean) as string[];

  const captionContext = contextBits.join(" | ") || null;
  const renderText = input.verificationResult?.suggestedJoke?.trim() || input.sourceTitle?.trim() || input.sourceDescription?.trim() || null;

  const shouldProceed = Boolean(input.verificationResult && input.verificationResult.accepted);

  return {
    proceed: shouldProceed,
    captionContext,
    renderText,
  };
}

export async function verifyAndClassifyMemeCandidate(input: MemeVerificationInput): Promise<MemeVerificationResult> {
  const prompt = [
    "Analyze this image for meme publishing quality.",
    input.sourceTitle ? `Source title: ${input.sourceTitle}` : "",
    input.sourceDescription ? `Source description: ${input.sourceDescription}` : "",
    input.mediaTags?.length ? `Source tags: ${input.mediaTags.join(", ")}` : "",
    "Return strict JSON with keys: is_meme_format (boolean), has_readable_text (boolean), extracted_text (string|null), context_description (string), quality_flag (good|low_res|watermarked|outdated_format), suggested_joke (string|null).",
    "Rules:",
    "- If the image already looks like a meme, screenshot, tweet, or reaction post, set is_meme_format true.",
    "- If OCR finds readable text like a tweet, punchline, or caption, return it in extracted_text.",
    "- suggested_joke should be populated only when there is no readable text and the image has enough context to support a fresh joke.",
    "- Reject low-res, watermarked, or clearly outdated/empty-format images.",
    input.ignoreExistingText
      ? "- This frame may contain a generic placeholder caption promoting video-editing software (e.g. mentioning 'Kapwing' or 'editing a project'). That text is not real meme content — ignore it completely, treat the image as having no caption at all, set has_readable_text false and extracted_text null, and always populate suggested_joke with a fresh original joke based on the subject's expression/scene and the source title/tags."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const geminiKeys = Array.from(
    new Set(
      (input.apiKeys?.length
        ? input.apiKeys
        : [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY]
      ).filter((key): key is string => Boolean(key)),
    ),
  );
  if (geminiKeys.length === 0) {
    return {
      accepted: false,
      reason: "missing_gemini_key",
      hasReadableText: false,
      extractedText: null,
      contextDescription: null,
      suggestedJoke: null,
      qualityFlag: "outdated_format",
    };
  }

  try {
    let text = "{}";
    let lastError: Error | null = null;
    let succeeded = false;

    // Quota exhaustion is per-key, not per-request — try every configured key
    // before giving up, same rotation GeminiClient.generateText already does.
    for (const geminiKey of geminiKeys) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: input.mimeType || "image/jpeg",
                      data: input.imageBase64,
                    },
                  },
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        lastError = new Error(`Gemini verification failed (${response.status}): ${bodyText.slice(0, 500)}`);
        continue;
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      succeeded = true;
      break;
    }

    if (!succeeded) {
      throw lastError ?? new Error("Gemini verification failed on all configured keys");
    }

    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
      is_meme_format?: boolean;
      has_readable_text?: boolean;
      extracted_text?: string;
      context_description?: string;
      quality_flag?: string;
      suggested_joke?: string;
    };

    const qualityFlag = (parsed.quality_flag as MemeVerificationResult["qualityFlag"]) || "good";
    // Defensive override: never trust "readable text" the model reports when we
    // told it to ignore a known placeholder caption, even if it didn't comply.
    const hasReadableText = input.ignoreExistingText ? false : Boolean(parsed.has_readable_text);
    const extractedText = input.ignoreExistingText ? null : parsed.extracted_text?.trim() || null;
    const suggestedJoke = parsed.suggested_joke?.trim() || null;
    const contextDescription = parsed.context_description?.trim() || null;

    if (qualityFlag === "low_res" || qualityFlag === "watermarked") {
      return {
        accepted: false,
        reason: `quality_${qualityFlag}`,
        hasReadableText,
        extractedText,
        contextDescription,
        suggestedJoke,
        qualityFlag,
      };
    }

    if (!parsed.is_meme_format && !contextDescription) {
      return {
        accepted: false,
        reason: "no_confident_context",
        hasReadableText,
        extractedText,
        contextDescription,
        suggestedJoke,
        qualityFlag,
      };
    }

    return {
      accepted: true,
      reason: "verified",
      hasReadableText,
      extractedText,
      contextDescription,
      suggestedJoke,
      qualityFlag,
    };
  } catch (error) {
    console.error(`[meme-verifier] verifyAndClassifyMemeCandidate failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      accepted: false,
      reason: "verification_error",
      hasReadableText: false,
      extractedText: null,
      contextDescription: null,
      suggestedJoke: null,
      qualityFlag: "outdated_format",
    };
  }
}
