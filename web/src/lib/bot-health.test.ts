import assert from "node:assert/strict";
import test from "node:test";

import { computeBotHealth } from "./bot-health.ts";
import type { Bot, PlatformAccount } from "../types/app.ts";

test("demo bots do not surface sleeping or missing-xenrio health issues", () => {
  const bot = {
    api_slot: 1,
    is_active: false,
    is_demo: true,
    connection_status: "connected",
    zernio_account_id: "demo-account",
    instagram_business_id: null,
  } as Partial<Bot> as Bot;

  const platformAccounts = [
    { platform: "instagram", connection_status: "connected" } as Partial<PlatformAccount> as PlatformAccount,
  ];

  const health = computeBotHealth(bot, platformAccounts);

  assert.ok(!health.issues.includes("Missing Xenrio key slot"));
  assert.ok(!health.issues.includes("Bot is sleeping"));
});
