export async function ensureDefaultPostingWindows(supabase: { from: (table: string) => any }, botId: string) {
  const { data: existing, error: listError } = await supabase.from("bot_posting_windows").select("id").eq("bot_id", botId);

  if (listError) throw listError;
  if ((existing ?? []).length > 0) {
    return existing as Array<{ id: string }>;
  }

  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    bot_id: botId,
    weekday,
    start_local: "00:00",
    end_local: "23:59",
  }));

  const { data, error: insertError } = await supabase.from("bot_posting_windows").insert(windows).select("id");

  if (insertError) throw insertError;
  return (data ?? []) as Array<{ id: string }>;
}
