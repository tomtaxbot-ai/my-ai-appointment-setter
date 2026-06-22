/**
 * Shared access-key check for the Jarvis HQ endpoints.
 * The key lives in the prompter_config table (single row); the Telegram bot
 * reads the same row to build links and authenticate proxy calls.
 */
import { supabase } from "@/lib/supabase";

let cachedKey: { value: string; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60_000;

export async function getAccessKey(): Promise<string | null> {
  if (cachedKey && Date.now() - cachedKey.fetchedAt < KEY_TTL_MS) {
    return cachedKey.value;
  }
  const { data, error } = await supabase
    .from("prompter_config")
    .select("access_key")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data?.access_key) return cachedKey?.value ?? null;
  cachedKey = { value: data.access_key, fetchedAt: Date.now() };
  return cachedKey.value;
}
