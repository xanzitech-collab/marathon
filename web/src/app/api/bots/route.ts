import { NextResponse } from "next/server";
import { botCreateSchema } from "@/lib/validators";
import { AppError, requireUser } from "@/lib/auth";
import { computeBotHealth } from "@/lib/bot-health";
import { getApiKeysBySlot } from "@/lib/config";
import { XenrioClient } from "@/lib/xenrio/client";
import { listPlatformAccounts } from "@/lib/platform-accounts";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();

    const { data, error } = await supabase
      .from("bots")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    type ZernioAccount = Awaited<ReturnType<XenrioClient["listAccounts"]>>[number];
    const accountsBySlot = new Map<number, Promise<ZernioAccount[] | null>>();
    const getAccountsForSlot = (apiSlot: number) => {
      const existing = accountsBySlot.get(apiSlot);
      if (existing) return existing;

      const request = new XenrioClient(getApiKeysBySlot(apiSlot).xenrio)
        .listAccounts()
        .catch((syncError) => {
          console.warn(`[Xenrio slot ${apiSlot}] Could not fetch live post counts: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
          return null;
        });
      accountsBySlot.set(apiSlot, request);
      return request;
    };

    const bots = await Promise.all(
      (data ?? []).map(async (bot) => {
        const platformAccounts = await listPlatformAccounts(supabase, bot.id);
        let externalPostCount: number | null = null;

        // Best-effort: show the real live count from connected platforms (via
        // Zernio) instead of our own all-time queue history, which doesn't
        // know about posts the user deleted directly on the platform.
        if (!bot.is_demo && platformAccounts.length > 0) {
          const accounts = await getAccountsForSlot(bot.api_slot);
          if (accounts) {
            externalPostCount = platformAccounts.reduce((sum, platformAccount) => {
              const account = accounts.find((candidate) => candidate.id === platformAccount.zernio_account_id);
              return sum + (account?.externalPostCount ?? 0);
            }, 0);
          }
        }

        return { ...bot, health: computeBotHealth(bot, platformAccounts), platformAccounts, externalPostCount };
      }),
    );

    return NextResponse.json({ bots });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load bots" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = await request.json();
    const parsed = botCreateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { count, error: countError } = await supabase
      .from("bots")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) throw countError;
    if ((count ?? 0) >= 5) {
      return NextResponse.json({ error: "Maximum 5 bots allowed" }, { status: 400 });
    }

    const payload = parsed.data;

    const { data, error } = await supabase
      .from("bots")
      .insert({
        user_id: user.id,
        name: payload.name,
        api_slot: payload.api_slot,
      })
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ bot: { ...data, health: computeBotHealth(data, []) } }, { status: 201 });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create bot" }, { status });
  }
}
