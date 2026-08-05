import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { GeminiClient } from "@/lib/gemini/client";
import { getApiKeysBySlot } from "@/lib/config";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (botError || !bot) {
      return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    }

    const body = (await request.json()) as { missionText?: string };
    const missionText = (body.missionText ?? "").trim();

    if (!missionText) {
      return NextResponse.json({ error: "Mission text is required" }, { status: 400 });
    }

    const { gemini } = getApiKeysBySlot(bot.api_slot);
    const geminiClient = new GeminiClient(gemini);
    const plan = await geminiClient.generateMissionPlan({
      missionText,
      persona: bot.persona,
      contentTarget: bot.content_target,
      location: [bot.city, bot.country].filter(Boolean).join(", "),
    });

    const { data, error } = await supabase
      .from("bots")
      .update({
        persona: plan.persona,
        additional_persona: plan.additionalPersona,
        content_target: plan.contentTarget,
        custom_target_prompt: plan.customTargetPrompt,
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ bot: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Mission build failed" }, { status: 500 });
  }
}
