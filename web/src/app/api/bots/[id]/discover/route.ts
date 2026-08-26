import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { discoverAndQueueContent } from "@/lib/discovery-ingest";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();
    let dryRun = process.env.DISCOVER_DRY_RUN === "true";

    try {
      const payload = (await request.json()) as { dryRun?: boolean } | null;
      if (payload && typeof payload.dryRun === "boolean") {
        dryRun = payload.dryRun;
      }
    } catch {
      // default to the environment setting
    }

    const { data: bot, error } = await supabase
      .from("bots")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error || !bot) {
      return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    }
    if (bot.is_demo) {
      return NextResponse.json({ error: "Demo bots cannot discover or queue live content." }, { status: 403 });
    }

    const admin = createAdminClient();

    if (dryRun) {
      // Dry runs just report what would happen without touching the queue table.
      // TODO: dry-run preview mode is not yet reimplemented on the shared ingest path.
      return NextResponse.json({ error: "Dry-run preview is temporarily unavailable" }, { status: 501 });
    }

    const result = await discoverAndQueueContent(supabase, admin, bot, { limit: 20, userId: user.id });
    return NextResponse.json({ discovered: result.discovered, queued: result.queued, skipped: result.skipped, dryRun: false, debug: result.debug });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 });
  }
}
