/**
 * Map a lead's free-text location (the country/city we capture in the Opener
 * stage, e.g. "uk", "i'm in italy", "United States") to an IANA timezone.
 *
 * Used at the Book stage so we ask GHL for Ethan's free slots IN THE LEAD'S
 * timezone — the slots then come back already expressed in their local time, so
 * the times we offer are correct without any manual conversion. Falls back to
 * the operator's own timezone when the country can't be determined.
 *
 * Big countries (US/Canada/Australia) span multiple zones; we pick the most
 * common business default. It is still confirmed with the lead in the message.
 */
const COUNTRY_TIMEZONES: Array<{ keys: string[]; tz: string }> = [
  { keys: ["united kingdom", "uk", "england", "scotland", "wales", "britain", "london", "gb"], tz: "Europe/London" },
  { keys: ["ireland", "dublin"], tz: "Europe/Dublin" },
  { keys: ["united states", "usa", "u.s", "us", "america", "states"], tz: "America/New_York" },
  { keys: ["canada", "toronto", "ontario"], tz: "America/Toronto" },
  { keys: ["sweden", "stockholm", "sverige"], tz: "Europe/Stockholm" },
  { keys: ["norway", "oslo"], tz: "Europe/Oslo" },
  { keys: ["denmark", "copenhagen"], tz: "Europe/Copenhagen" },
  { keys: ["finland", "helsinki"], tz: "Europe/Helsinki" },
  { keys: ["germany", "berlin", "deutschland"], tz: "Europe/Berlin" },
  { keys: ["netherlands", "holland", "amsterdam"], tz: "Europe/Amsterdam" },
  { keys: ["belgium", "brussels"], tz: "Europe/Brussels" },
  { keys: ["france", "paris"], tz: "Europe/Paris" },
  { keys: ["spain", "madrid"], tz: "Europe/Madrid" },
  { keys: ["portugal", "lisbon"], tz: "Europe/Lisbon" },
  { keys: ["italy", "rome", "milan"], tz: "Europe/Rome" },
  { keys: ["switzerland", "zurich"], tz: "Europe/Zurich" },
  { keys: ["austria", "vienna"], tz: "Europe/Vienna" },
  { keys: ["poland", "warsaw"], tz: "Europe/Warsaw" },
  { keys: ["greece", "athens"], tz: "Europe/Athens" },
  { keys: ["uae", "dubai", "abu dhabi", "emirates"], tz: "Asia/Dubai" },
  { keys: ["saudi", "riyadh"], tz: "Asia/Riyadh" },
  { keys: ["india", "mumbai", "delhi"], tz: "Asia/Kolkata" },
  { keys: ["australia", "sydney", "melbourne"], tz: "Australia/Sydney" },
  { keys: ["new zealand", "auckland"], tz: "Pacific/Auckland" },
  { keys: ["south africa", "johannesburg", "cape town"], tz: "Africa/Johannesburg" },
];

/**
 * Resolve an IANA timezone from a free-text location, or null if unknown.
 * Matching is word-boundary aware so "us" doesn't match inside "australia".
 */
export function countryToTimezone(location: string | null | undefined): string | null {
  if (!location) return null;
  const t = ` ${location.toLowerCase().replace(/[^a-z. ]+/g, " ")} `;
  for (const { keys, tz } of COUNTRY_TIMEZONES) {
    for (const k of keys) {
      if (t.includes(` ${k} `)) return tz;
    }
  }
  return null;
}
