/**
 * BAN LIST (enforcement side)
 * ---------------------------
 * A banned contact is one Maher has explicitly told Jarvis to erase and keep
 * out forever (e.g. a slow-burn pitcher only unmasked after several messages).
 * Bans are issued from the Telegram side (see telegram_bot/setter_control.py),
 * which deletes the contact from GHL + the DB and writes a row into the
 * `banned_contacts` table. This module is the READ side the webhook uses to
 * enforce that ban on every inbound message.
 *
 * Identity matching: GHL deletes-and-recreates a contact when a banned person
 * DMs again, minting a NEW ghl_contact_id — so the durable key is the Instagram
 * handle. We match an inbound against any ACTIVE ban on ghl_contact_id OR
 * ig_username OR ig_sender_id. Handles are normalized (lowercased, no leading
 * '@') on BOTH write and read so they compare equal.
 *
 * Unbanning sets active=false (the row is kept as history), so a re-DM after an
 * unban is treated as a brand-new lead again.
 */

import { supabase } from "./supabase";

export interface BanIdentifiers {
  ghl_contact_id?: string | null;
  ig_username?: string | null;
  ig_sender_id?: string | null;
}

export interface BanRow {
  id: string;
  client_id: string;
  ghl_contact_id: string | null;
  ig_username: string | null;
  ig_sender_id: string | null;
  full_name: string | null;
  reason: string | null;
  active: boolean;
}

/**
 * Normalize an Instagram handle so it compares equal regardless of how it was
 * entered: trim, drop a leading '@', lowercase. Returns null for empty input.
 * MUST stay in sync with the Python side (setter_control._normalize_handle).
 */
export function normalizeHandle(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.trim().replace(/^@+/, "").toLowerCase();
  return h.length > 0 ? h : null;
}

/** PostgREST `.or()` is comma-separated; a value containing one would break the
 *  filter. IG handles and GHL/IG ids never contain commas, but we guard anyway
 *  by dropping any identifier that does rather than risk a malformed query. */
function safe(value: string): boolean {
  return !value.includes(",") && !value.includes("(") && !value.includes(")");
}

/**
 * Return the matching ACTIVE ban row for an inbound contact, or null if the
 * contact is not banned. Best-effort: on a query error we FAIL OPEN (return
 * null) so a transient DB blip never silently drops a legitimate lead — a
 * missed ban is recoverable (Maher can re-ban), a dropped real lead is not.
 */
export async function findActiveBan(
  client_id: string,
  ids: BanIdentifiers
): Promise<BanRow | null> {
  const conditions: string[] = [];

  if (ids.ghl_contact_id && safe(ids.ghl_contact_id)) {
    conditions.push(`ghl_contact_id.eq.${ids.ghl_contact_id}`);
  }
  const handle = normalizeHandle(ids.ig_username);
  if (handle && safe(handle)) {
    conditions.push(`ig_username.eq.${handle}`);
  }
  if (ids.ig_sender_id && safe(ids.ig_sender_id)) {
    conditions.push(`ig_sender_id.eq.${ids.ig_sender_id}`);
  }

  if (conditions.length === 0) return null;

  const { data, error } = await supabase
    .from("banned_contacts")
    .select("id,client_id,ghl_contact_id,ig_username,ig_sender_id,full_name,reason,active")
    .eq("client_id", client_id)
    .eq("active", true)
    .or(conditions.join(","))
    .limit(1);

  if (error) {
    console.error("[bans] findActiveBan query failed (failing open):", error);
    return null;
  }
  return data && data.length > 0 ? (data[0] as BanRow) : null;
}
