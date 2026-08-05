import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ARTIST_CONTEXT } from "@/lib/artist";

export async function GET() {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("artist_monitor_snapshots")
      .select("*")
      .eq("source_handle", ARTIST_CONTEXT.instagramHandle)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    return NextResponse.json({ snapshots: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Monitoring failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const body = await request.json();

    const { error } = await supabase.from("artist_monitor_snapshots").upsert({
      source_platform: "instagram",
      source_handle: ARTIST_CONTEXT.instagramHandle,
      external_post_id: body.external_post_id,
      content_type: body.content_type ?? null,
      caption: body.caption ?? null,
      media_url: body.media_url ?? null,
      posted_at: body.posted_at ?? null,
      metrics: body.metrics ?? {},
    });

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Monitor ingest failed" }, { status: 500 });
  }
}
