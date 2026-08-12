import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "app-secrets";
const COOKIES_PATH = "x-cookies.txt";

export async function GET() {
  try {
    await requireUser();
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).list("", { search: COOKIES_PATH });
    if (error) throw error;

    const file = (data ?? []).find((item) => item.name === COOKIES_PATH);
    return NextResponse.json({
      exists: Boolean(file),
      updatedAt: file?.updated_at ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireUser();
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A cookies.txt file is required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const admin = createAdminClient();

    // upsert overwrites the same fixed path, so a fresh upload automatically
    // replaces/expires whatever cookies file was there before.
    const { error } = await admin.storage.from(BUCKET).upload(COOKIES_PATH, buffer, {
      contentType: "text/plain",
      upsert: true,
    });
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await requireUser();
    const admin = createAdminClient();
    const { error } = await admin.storage.from(BUCKET).remove([COOKIES_PATH]);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
