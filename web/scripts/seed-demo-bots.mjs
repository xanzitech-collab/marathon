import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// Seeds visibly-flagged demo channels (is_demo = true, is_active = false so
// the automation loop / real Zernio publishing never touches them) purely so
// the dashboard can be previewed at a larger scale than the 1-2 real
// channels. These are NOT real connected accounts — every Instagram handle
// and zernio_account_id here is fabricated and clearly marked as demo data.

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const LOCATIONS = [
  { city: "Cape Town", country: "South Africa", timezone: "Africa/Johannesburg" },
  { city: "Johannesburg", country: "South Africa", timezone: "Africa/Johannesburg" },
  { city: "Durban", country: "South Africa", timezone: "Africa/Johannesburg" },
  { city: "Pretoria", country: "South Africa", timezone: "Africa/Johannesburg" },
  { city: "Lagos", country: "Nigeria", timezone: "Africa/Lagos" },
  { city: "Accra", country: "Ghana", timezone: "Africa/Accra" },
  { city: "Nairobi", country: "Kenya", timezone: "Africa/Nairobi" },
  { city: "Kampala", country: "Uganda", timezone: "Africa/Kampala" },
  { city: "London", country: "United Kingdom", timezone: "Europe/London" },
  { city: "Manchester", country: "United Kingdom", timezone: "Europe/London" },
  { city: "Berlin", country: "Germany", timezone: "Europe/Berlin" },
  { city: "Amsterdam", country: "Netherlands", timezone: "Europe/Amsterdam" },
  { city: "Paris", country: "France", timezone: "Europe/Paris" },
  { city: "Lisbon", country: "Portugal", timezone: "Europe/Lisbon" },
  { city: "New York", country: "United States", timezone: "America/New_York" },
  { city: "Atlanta", country: "United States", timezone: "America/New_York" },
  { city: "Los Angeles", country: "United States", timezone: "America/Los_Angeles" },
  { city: "Houston", country: "United States", timezone: "America/Chicago" },
  { city: "Toronto", country: "Canada", timezone: "America/Toronto" },
  { city: "Dubai", country: "United Arab Emirates", timezone: "Asia/Dubai" },
];

const NAME_PREFIXES = [
  "Naija", "Afro", "Street", "Urban", "City", "Lagos", "Cape", "London",
  "Diaspora", "Continental", "Motherland", "Vibe", "Culture", "Bassline",
];
const NAME_SUFFIXES = [
  "Vibes", "Nights", "Sounds", "Culture", "Beats", "Fans", "Collective",
  "Hub", "Groove", "Radio", "Scene", "Wave", "Society", "Network",
];

const PERSONAS = ["afrobeats_hype_editor", "street_culture_curator", "fan_community_voice", "release_countdown_host"];
const CONTENT_TARGETS = [
  "fan_engagement", "lifestyle_vibes", "viral_trends", "fan_reactions",
  "behind_the_scenes", "throwback_moments", "tour_hype",
];
const FREQUENCIES = ["daily", "every_n_days", "weekdays_only"];

function pick(list, index) {
  return list[index % list.length];
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function main() {
  const scriptFilePath = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(scriptFilePath), "..");
  loadEnvFile(path.join(rootDir, ".env.local"));
  loadEnvFile(path.join(rootDir, ".env"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers();
  if (usersError) throw new Error(`Could not list users: ${usersError.message}`);
  const localUser = usersData.users.find((u) => u.email?.toLowerCase() === "marathon@local.only1");
  if (!localUser) throw new Error("Could not find the local app user (marathon@local.only1).");

  const count = Number(process.argv[2] ?? 20);
  const offset = Number(process.argv[3] ?? 0);
  let created = 0;

  for (let i = 0; i < count; i += 1) {
    const n = i + offset;
    const location = pick(LOCATIONS, n);
    const name = `${pick(NAME_PREFIXES, n)} ${pick(NAME_SUFFIXES, n + 3)}`;
    const persona = pick(PERSONAS, n);
    const contentTarget = pick(CONTENT_TARGETS, n + 1);
    const frequencyMode = pick(FREQUENCIES, n);
    const apiSlot = (n % 5) + 1;

    const { data: bot, error: botError } = await supabase
      .from("bots")
      .insert({
        user_id: localUser.id,
        name,
        api_slot: apiSlot,
        is_active: false, // never picked up by the automation loop / real publishing
        is_demo: true,
        timezone: location.timezone,
        country: location.country,
        city: location.city,
        language: "en",
        persona,
        content_target: contentTarget,
        frequency_mode: frequencyMode,
        every_n_days: frequencyMode === "every_n_days" ? 3 : null,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        max_posts_per_day: 2,
        cooldown_minutes: 240,
        connection_status: "connected",
      })
      .select("id")
      .single();

    if (botError || !bot) {
      console.error(`Failed to create demo bot ${name}: ${botError?.message}`);
      continue;
    }

    const handle = `${slugify(name)}${100 + n}`;
    const { error: accountError } = await supabase.from("bot_platform_accounts").insert({
      bot_id: bot.id,
      platform: "instagram",
      zernio_account_id: `demo-${bot.id}`,
      username: handle,
      connection_status: "connected",
    });

    if (accountError) {
      console.error(`Failed to create demo platform account for ${name}: ${accountError.message}`);
      continue;
    }

    created += 1;
    console.log(`Created demo bot: ${name} (@${handle}) — ${location.city}, ${location.country}`);
  }

  console.log(`\nDone. ${created}/${count} demo channels created.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seeding demo bots failed");
  process.exitCode = 1;
});
