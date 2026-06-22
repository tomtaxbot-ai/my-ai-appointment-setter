/**
 * SOURCING — source capture + booking model helpers (pure, unit-tested).
 *
 * Phase 1: derive a lead's first-touch source from the opt-in form's hidden
 *          UTM fields and/or the contact's FIRST attributionSource.
 * Phase 2: detect the AI's calendar/booking links in an outgoing DM and tag
 *          them with utm_medium=ai_dm.
 * Phase 3: resolve booking_method (last touch) when a lead becomes booked.
 *
 * Every UTM value we store is lowercased.
 */

/** Lowercase + trim; empty/nullish => null. */
export function lc(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

/** A GHL attribution object (attributionSource / lastAttributionSource). */
export type AttributionSource = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  medium?: string;
  source?: string;
  sessionSource?: string;
  referrer?: string;
  [k: string]: unknown;
};

export type LeadSource = {
  src_channel: string | null;
  src_placement: string | null;
  src_campaign: string | null;
  src_content: string | null;
  /** True only when the UTM came from the opt-in FORM's hidden fields. */
  opted_in: boolean;
};

type Utm = { source: string | null; medium: string | null; campaign: string | null; content: string | null };

/** Read utm_* from a flat bag (case-insensitive, accepts utm_source or utmSource). */
function utmFromBag(bag: Record<string, unknown> | null | undefined): Utm | null {
  if (!bag || typeof bag !== "object") return null;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) lower[k.toLowerCase().replace(/[^a-z]/g, "")] = v;
  const source = lc(lower["utmsource"]);
  const medium = lc(lower["utmmedium"]);
  const campaign = lc(lower["utmcampaign"]);
  const content = lc(lower["utmcontent"]);
  if (!source && !medium && !campaign && !content) return null;
  return { source, medium, campaign, content };
}

/** Pull utm_* off a GHL attribution object. */
function utmFromAttribution(attr: AttributionSource | null | undefined): Utm | null {
  if (!attr || typeof attr !== "object") return null;
  const source = lc(attr.utmSource);
  const medium = lc(attr.utmMedium);
  const campaign = lc(attr.utmCampaign);
  const content = lc(attr.utmContent);
  if (!source && !medium && !campaign && !content) return null;
  return { source, medium, campaign, content };
}

/**
 * Derive the lead's first-touch source.
 *  1. Form hidden fields (customData utm_*) — a real opt-in => opted_in=true.
 *  2. Else the contact's FIRST attributionSource utm_*.
 *  3. Else derive channel/placement from the attribution's platform
 *     (e.g. medium "instagram" => channel 'instagram', placement 'dm').
 */
export function deriveLeadSource(params: {
  customData?: Record<string, unknown> | null;
  firstAttribution?: AttributionSource | null;
}): LeadSource {
  const empty: LeadSource = {
    src_channel: null,
    src_placement: null,
    src_campaign: null,
    src_content: null,
    opted_in: false,
  };

  // 1. Opt-in form hidden fields.
  const formUtm = utmFromBag(params.customData);
  if (formUtm) {
    return {
      src_channel: formUtm.source,
      src_placement: formUtm.medium,
      src_campaign: formUtm.campaign,
      src_content: formUtm.content,
      opted_in: true,
    };
  }

  // 2. First-touch attribution UTM.
  const attrUtm = utmFromAttribution(params.firstAttribution);
  if (attrUtm) {
    return {
      src_channel: attrUtm.source,
      src_placement: attrUtm.medium,
      src_campaign: attrUtm.campaign,
      src_content: attrUtm.content,
      opted_in: false,
    };
  }

  // 3. No UTM at all (pure DM lead): derive from the attribution platform.
  const attr = params.firstAttribution;
  if (attr) {
    const channel = lc(attr.medium) || lc(attr.source) || lc(attr.sessionSource);
    if (channel) {
      return { ...empty, src_channel: channel, src_placement: "dm" };
    }
  }

  return empty;
}

/** True if this LeadSource carries any real signal worth persisting. */
export function hasSourceSignal(s: LeadSource): boolean {
  return !!(s.src_channel || s.src_placement || s.src_campaign || s.src_content || s.opted_in);
}

// ---------------------------------------------------------------------------
// Phase 2 — AI booking links
// ---------------------------------------------------------------------------

const BOOKING_URL_HINTS: RegExp[] = [
  /leadconnectorhq\.com\/widget\/booking/i,
  /\/widget\/bookings?\b/i,
  /calendly\.com/i,
  /cal\.com/i,
  /acuityscheduling/i,
  /\/interview\b/i,
  /\bcalendar\b/i,
  /\/book(ing)?\b/i,
];

const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

export function isBookingUrl(url: string): boolean {
  return BOOKING_URL_HINTS.some((re) => re.test(url));
}

/** Add/override utm_medium=ai_dm on a single URL. Returns the URL unchanged on parse failure. */
function withAiDmMedium(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_medium", "ai_dm");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Tag every booking/calendar link in an outgoing message with utm_medium=ai_dm.
 * Returns the rewritten text and whether any booking link was present.
 */
export function tagBookingLinks(text: string): { text: string; hadBookingLink: boolean } {
  let had = false;
  const out = text.replace(URL_RE, (raw) => {
    // Don't let trailing punctuation glued to the URL break parsing.
    const m = raw.match(/^(.*?)([.,!?;:]*)$/s);
    const core = m ? m[1] : raw;
    const trail = m ? m[2] : "";
    if (!isBookingUrl(core)) return raw;
    had = true;
    return withAiDmMedium(core) + trail;
  });
  return { text: out, hadBookingLink: had };
}

// ---------------------------------------------------------------------------
// Phase 3 — booking method (last touch)
// ---------------------------------------------------------------------------

/**
 * Resolve booking_method when a lead becomes booked.
 *  - existing 'dialing' is NEVER overwritten (the bot sets that).
 *  - an ai_sent_booking_link before the booking => 'ai_dm'.
 *  - else the lastAttribution utm_medium (email / sms / skool / self_serve…).
 *  - else 'self_serve'.
 */
export function resolveBookingMethod(opts: {
  existing: string | null;
  aiSentLink: boolean;
  lastAttribution?: AttributionSource | null;
}): string {
  if (opts.existing === "dialing") return "dialing";
  if (opts.aiSentLink) return "ai_dm";
  const medium = lc(opts.lastAttribution?.utmMedium) || lc(opts.lastAttribution?.medium);
  if (medium) return medium;
  return "self_serve";
}
