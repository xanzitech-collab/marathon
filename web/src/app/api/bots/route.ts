import { NextResponse } from "next/server";
import { botCreateSchema } from "@/lib/validators";
import { AppError, requireUser } from "@/lib/auth";
import { computeBotHealth } from "@/lib/bot-health";
import { getApiKeysBySlot } from "@/lib/config";
import { XenrioClient } from "@/lib/xenrio/client";
import type { BotWithHealth, PlatformAccount } from "@/types/app";

type ZernioAccount = Awaited<ReturnType<XenrioClient["listAccounts"]>>[number];

const LIVE_COUNT_CACHE_MS = 60_000;
const PLATFORM_ACCOUNT_BATCH_SIZE = 100;
const globalState = globalThis as typeof globalThis & {
  __marathonZernioAccountsCache?: Map<number, { expiresAt: number; accounts: ZernioAccount[] | null }>;
};
const accountsBySlot = globalState.__marathonZernioAccountsCache ?? new Map<number, { expiresAt: number; accounts: ZernioAccount[] | null }>();
globalState.__marathonZernioAccountsCache = accountsBySlot;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

async function getAccountsForSlot(apiSlot: number): Promise<ZernioAccount[] | null> {
  const cached = accountsBySlot.get(apiSlot);
  if (cached && cached.expiresAt > Date.now()) return cached.accounts;

  try {
    const accounts = await new XenrioClient(getApiKeysBySlot(apiSlot).xenrio).listAccounts();
    accountsBySlot.set(apiSlot, { accounts, expiresAt: Date.now() + LIVE_COUNT_CACHE_MS });
    return accounts;
  } catch (syncError) {
    console.warn(`[Xenrio slot ${apiSlot}] Could not fetch live post counts: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
    accountsBySlot.set(apiSlot, { accounts: null, expiresAt: Date.now() + LIVE_COUNT_CACHE_MS });
    return null;
  }
}

export async function GET() {
  try {
    const { supabase, user } = await requireUser();

    const { data, error } = await supabase
      .from("bots")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    const botRows = data ?? [];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        const bots: BotWithHealth[] = botRows.map((bot) => {
          const platformAccounts: PlatformAccount[] = [];
          return { ...bot, health: computeBotHealth(bot, platformAccounts), platformAccounts, externalPostCount: null };
        });

        // Local database data is emitted immediately so the dashboard can
        // paint cards without waiting on a third-party API.
        for (const bot of bots) emit({ type: "bot", bot });

        for (const batch of chunks(bots, PLATFORM_ACCOUNT_BATCH_SIZE)) {
          const { data: platformAccountRows, error: platformAccountsError } = await supabase
            .from("bot_platform_accounts")
            .select("*")
            .in("bot_id", batch.map((bot) => bot.id));
          if (platformAccountsError) throw platformAccountsError;

          const platformAccountsByBot = new Map<string, PlatformAccount[]>();
          for (const account of platformAccountRows ?? []) {
            const accounts = platformAccountsByBot.get(account.bot_id) ?? [];
            accounts.push(account);
            platformAccountsByBot.set(account.bot_id, accounts);
          }

          for (const bot of batch) {
            bot.platformAccounts = platformAccountsByBot.get(bot.id) ?? [];
            bot.health = computeBotHealth(bot, bot.platformAccounts);
            emit({ type: "bot", bot });
          }
        }

        const activeSlots = Array.from(new Set(bots.filter((bot) => !bot.is_demo && (bot.platformAccounts?.length ?? 0) > 0).map((bot) => bot.api_slot)));
        await Promise.all(activeSlots.map(async (apiSlot) => {
          const accounts = await getAccountsForSlot(apiSlot);
          if (!accounts) return;
          for (const bot of bots.filter((candidate) => candidate.api_slot === apiSlot && !candidate.is_demo)) {
            const externalPostCount = (bot.platformAccounts ?? []).reduce((sum: number, platformAccount: PlatformAccount) => {
              const account = accounts.find((candidate) => candidate.id === platformAccount.zernio_account_id);
              return sum + (account?.externalPostCount ?? 0);
            }, 0);
            emit({ type: "count", botId: bot.id, externalPostCount });
          }
        }));

        emit({ type: "done" });
        controller.close();
      },
      cancel() {
        // The dashboard may navigate away while a large batch is loading.
      },
    });

    return new NextResponse(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
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
