import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { botUpdateSchema } from "@/lib/validators";
import { computeBotHealth } from "@/lib/bot-health";
import { isFocusAligned } from "@/lib/content-guard";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { data, error } = await supabase
      .from("bots")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error) throw error;

    return NextResponse.json({ bot: { ...data, health: computeBotHealth(data) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Not found" }, { status: 404 });
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();
    const body = await request.json();
    const parsed = botUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { data: beforeBot } = await supabase
      .from("bots")
      .select("id,content_target")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    const { data, error } = await supabase
      .from("bots")
      .update(parsed.data)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    const oldTarget = beforeBot?.content_target;
    const newTarget = data.content_target;

    if (oldTarget && newTarget && oldTarget !== newTarget) {
      const { data: queuedItems } = await supabase
        .from("content_queue")
        .select("id,metadata,status")
        .eq("bot_id", id)
        .in("status", ["queued", "ready"])
        .order("created_at", { ascending: false })
        .limit(200);

      const idsToCancel = (queuedItems ?? [])
        .filter((item) => {
          const metadata =
            item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
              ? (item.metadata as Record<string, unknown>)
              : {};
          const aligned = isFocusAligned(newTarget, {
            title: typeof metadata.discovery_title === "string" ? metadata.discovery_title : null,
            description: typeof metadata.discovery_description === "string" ? metadata.discovery_description : null,
            source: typeof metadata.source === "string" ? metadata.source : null,
            sourceUrl: typeof metadata.source_url === "string" ? metadata.source_url : null,
            tags: Array.isArray(metadata.tags) ? metadata.tags.filter((v): v is string => typeof v === "string") : null,
          });
          return !aligned;
        })
        .map((item) => item.id);

      if (idsToCancel.length > 0) {
        await supabase
          .from("content_queue")
          .update({
            status: "cancelled",
            error_message: `Auto-pruned after content focus changed to '${newTarget}'`,
          })
          .in("id", idsToCancel);
      }
    }

    return NextResponse.json({ bot: { ...data, health: computeBotHealth(data) } });
  } catch (error) {
    const maybeDbError = error as { code?: string; message?: string };
    const message = error instanceof Error ? error.message : "Failed to update";

    if (maybeDbError?.code === "23514" || message.includes("bots_cooldown_minutes_chk")) {
      return NextResponse.json(
        { error: "Cooldown must be between 30 and 1440 minutes." },
        { status: 400 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { supabase, user } = await requireUser();

    const { error } = await supabase.from("bots").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete" }, { status: 500 });
  }
}
