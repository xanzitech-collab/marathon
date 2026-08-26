import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listLocalVaultCategories } from "@/lib/meme-vault";

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json({ categories: await listLocalVaultCategories() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
