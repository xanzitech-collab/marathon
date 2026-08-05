import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const formData = await request.formData();
    const file = formData.get("file");
    const botId = formData.get("botId");

    if (!(file instanceof File) || !botId) {
      return NextResponse.json({ error: "File and botId are required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop() ?? "bin";
    const storagePath = `bot-media/${user.id}/${botId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const admin = createAdminClient();
    const { error: uploadError } = await admin.storage.from("bot-media").upload(storagePath, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = admin.storage.from("bot-media").getPublicUrl(storagePath);

    return NextResponse.json({
      publicUrl: publicUrlData.publicUrl,
      storagePath,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 500 });
  }
}
