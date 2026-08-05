import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envPath = new URL('../.env.local', import.meta.url);
const envContent = readFileSync(envPath, 'utf8');
const env = Object.fromEntries(
  envContent
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await supabase.from('content_queue').select('id, generated_caption, bot_id').is('generated_caption', null).limit(100);
if (error) {
  console.error(error);
  process.exit(1);
}

console.log(`Found ${rows?.length ?? 0} rows to backfill`);
for (const row of rows ?? []) {
  const { error: updateError } = await supabase.from('content_queue').update({ generated_caption: `Queued post for bot ${row.bot_id}` }).eq('id', row.id);
  if (updateError) {
    console.error('Failed to update', row.id, updateError.message);
  }
}
