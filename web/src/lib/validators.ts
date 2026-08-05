import { z } from "zod";
import { HARD_MAX_POSTS_PER_DAY } from "@/lib/config";

export const botCreateSchema = z.object({
  name: z.string().min(2).max(80),
  api_slot: z.number().int().min(1).max(5),
});

export const botUpdateSchema = z.object({
  name: z.string().min(2).max(80),
  is_active: z.boolean(),
  timezone: z.string().min(2).max(100),
  country: z.string().max(80).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  language: z.string().max(20),
  persona: z.string().min(2).max(80),
  additional_persona: z.string().max(500).nullable().optional(),
  content_target: z.string().min(2).max(80),
  custom_target_prompt: z.string().max(1000).nullable().optional(),
  mission_text: z.string().max(2000).nullable().optional(),
  frequency_mode: z.enum(["daily", "every_n_days", "weekdays_only"]),
  every_n_days: z.number().int().min(2).max(14).nullable().optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  max_posts_per_day: z.number().int().min(1).max(HARD_MAX_POSTS_PER_DAY),
  cooldown_minutes: z.number().int().min(30).max(1440),
});

export const queueCreateSchema = z.object({
  media_asset_id: z.string().uuid().nullable().optional(),
  surface: z.enum(["feed", "reel", "story"]).default("feed"),
  scheduled_for: z.string().datetime().nullable().optional(),
  generated_caption: z.string().max(2200).nullable().optional(),
});
