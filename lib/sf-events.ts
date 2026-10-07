import { getServiceClient, getSupabase } from "@/lib/supabase";

export type SfEventCategory =
  | "food"
  | "nightlife"
  | "outdoors"
  | "music"
  | "comedy"
  | "arts"
  | "sports";

export type SfVoteSignal = "up" | "down" | "busy";

export interface SfEvent {
  id: string;
  source: "funcheap" | "19hz" | "sfstation" | "ticketmaster";
  sourceUrl: string;
  title: string;
  description: string | null;
  category: SfEventCategory;
  /** Tier 1 = top-3 priorities (food, nightlife, outdoors); Tier 2 = secondary categories. */
  tier: 1 | 2;
  startsAt: string;
  endsAt: string | null;
  venue: string | null;
  neighborhood: string | null;
  priceText: string | null;
  isFree: boolean;
  imageUrl: string | null;
  tags: string[];
  dedupeKey: string;
}

export interface SfEventFeedback {
  eventId: string;
  signal: SfVoteSignal;
  tagsSnapshot: string[];
  eventTitle?: string | null;
  updatedAt: string;
}

export interface TasteProfile {
  /** Tag -> accumulated raw weight from votes (+1 for up, +0.2 for busy, -1 for down). */
  tagWeights: Record<string, number>;
  /** Number of thumbs-up votes recorded. */
  upCount: number;
  /** Number of busy ("good vibe, bad timing") votes recorded. */
  busyCount: number;
  /** Number of thumbs-down votes recorded. */
  downCount: number;
  /** Top positive human-readable tag labels for display in the taste profile bar. */
  topLikedTags: Array<{ tag: string; label: string; weight: number }>;
  /** Top negative human-readable tag labels for display in the taste profile bar. */
  topAvoidedTags: Array<{ tag: string; label: string; weight: number }>;
}

export interface RankedSfEvent {
  event: SfEvent;
  score: number;
  reasons: string[];
  userSignal: SfVoteSignal | null;
  isWildcard?: boolean;
}

export interface SfSyncSummary {
  fetched: number;
  deduped: number;
  persistedToDb: boolean;
  bySource: Record<string, number>;
  errors: string[];
}

/**
 * Category metadata and Tier 1 vs Tier 2 base weights.
 * Tier 1 (Food & Drink, Nightlife, Outdoors) receives a higher base score by default.
 */
export const SF_CATEGORY_META: Record<
  SfEventCategory,
  { label: string; emoji: string; tier: 1 | 2; baseScore: number }
> = {
  food: { label: "Food & Drink", emoji: "🍜", tier: 1, baseScore: 3.3 },
  nightlife: { label: "Nightlife", emoji: "🪩", tier: 1, baseScore: 3.3 },
  outdoors: { label: "Outdoors", emoji: "🌲", tier: 1, baseScore: 3.3 },
  music: { label: "Live Music", emoji: "🎸", tier: 2, baseScore: 1.7 },
  comedy: { label: "Comedy", emoji: "🎤", tier: 2, baseScore: 1.5 },
  arts: { label: "Arts & Culture", emoji: "🎨", tier: 2, baseScore: 1.3 },
  sports: { label: "Sports & Rec", emoji: "🏃", tier: 2, baseScore: 1.2 },
};

const SIGNAL_WEIGHTS: Record<SfVoteSignal, number> = {
  up: 1.0,
  busy: 0.2, // Positive vibe signal ("I'd go if I weren't busy") without penalizing tags
  down: -1.0,
};

const NON_SF_CITIES_REGEX =
  /\((?:Oakland|Berkeley|San Jose|Palo Alto|Stockton|Santa Cruz|Walnut Creek|Alameda|Concord|Fremont|Hayward|Richmond|San Mateo|Redwood City|Mountain View|Sunnyvale|Marin|Sausalito|Mill Valley|Napa|Sonoma|Petaluma|Vallejo|Pleasanton|Livermore|Dublin|Cupertino|Campbell|Santa Clara|Los Gatos|Half Moon Bay|Pacifica|Daly City|South SF|East Bay|North Bay|South Bay|Peninsula)\)/i;

const SF_NEIGHBORHOOD_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:mission district|the mission|valencia st|24th st|16th st|18th st|public works|chapel|the knockout|el rio|make-out room|sycamore)\b/i, "Mission"],
  [/\b(?:soma|south of market|folsom|howard st|11th st|f8|monarch|halcyon|audio sf|great northern|dna lounge|1015 folsom|underdogs|black hammer|bergerac|butter|tempest)\b/i, "SoMa"],
  [/\b(?:castro|upper market)\b/i, "Castro"],
  [/\b(?:hayes valley|patricia's green|sfjazz|davies symphony|biergarten)\b/i, "Hayes Valley"],
  [/\b(?:north beach|columbus ave|grant ave|bimbo's|cobb's|vesuvio|saloon|telegraph hill)\b/i, "North Beach"],
  [/\b(?:golden gate park|ggp|cal academy|de young|botanical garden|hippie hill|jfk promenade|bandshell)\b/i, "Golden Gate Park"],
  [/\b(?:presidio|crissy field|tunnel tops|fort point|lands end|house of air)\b/i, "Presidio"],
  [/\b(?:fort mason)\b/i, "Fort Mason"],
  [/\b(?:marina|chestnut st|union st|cow hollow|palace of fine arts|balboa theater)\b/i, "Marina"],
  [/\b(?:sunset|ocean beach|irving st|judah|sunset dunes|outer sunset|inner sunset)\b/i, "Sunset"],
  [/\b(?:richmond district|clement st|geary|balboa st|inner richmond|outer richmond)\b/i, "Richmond"],
  [/\b(?:dogpatch|the midway|minnesota st|22nd st|pier 70|crane cove)\b/i, "Dogpatch"],
  [/\b(?:potrero|potrero hill|bottom of the hill|anchor public taps)\b/i, "Potrero Hill"],
  [/\b(?:embarcadero|ferry building|pier 39|fisherman's wharf|pier 15|exploratorium|aquarium of the bay)\b/i, "Embarcadero"],
  [/\b(?:chinatown|portsmouth square|waverly)\b/i, "Chinatown"],
  [/\b(?:japantown|peace plaza)\b/i, "Japantown"],
  [/\b(?:fillmore|the fillmore|boom boom room|alamo square|painted ladies|divisadero|independent|madrone)\b/i, "Fillmore / NOPA"],
  [/\b(?:haight|lower haight|haight-ashbury|upper haight|noc noc|toronado)\b/i, "Haight"],
  [/\b(?:nob hill|polk st|grace cathedral|masonic|great american music hall|regency ballroom|rye|mayes)\b/i, "Nob Hill / Polk"],
  [/\b(?:union square|yerba buena|downtown|financial district|fidi|market st|warfield)\b/i, "Downtown"],
  [/\b(?:bernal|bernal heights|cortland|alemany)\b/i, "Bernal Heights"],
  [/\b(?:noe valley|24th street)\b/i, "Noe Valley"],
  [/\b(?:mission bay|chase center|spark social|thrive city)\b/i, "Mission Bay"],
  [/\b(?:treasure island)\b/i, "Treasure Island"],
];

/**
 * Decodes numeric and named HTML entities into clean UTF-8 characters.
 *
 * @param input - Raw string potentially containing HTML entities.
 * @returns Clean human-readable text.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input) return "";
  return input
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      if (code === 150) return "–";
      if (code === 151) return "—";
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&lsquo;|&#8216;/g, "‘")
    .replace(/&ldquo;|&#8220;/g, "“")
    .replace(/&rdquo;|&#8221;/g, "”")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&hellip;|&#8230;/g, "…")
    .replace(/&amp;|&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips HTML tags and decodes HTML entities from a snippet.
 *
 * @param html - Raw HTML string.
 * @returns Plain text string.
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return decodeHtmlEntities(withoutScripts.replace(/<[^>]+>/g, " "));
}

/**
 * Normalizes a title + date into a deterministic deduplication key so identical
 * events across multiple feeds or category pages collapse into a single card.
 *
 * @param title - Event title.
 * @param startsAtIso - ISO timestamp string for the event start.
 * @returns Normalized deduplication key.
 */
export function buildDedupeKey(title: string, startsAtIso: string): string {
  const cleanTitle = decodeHtmlEntities(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(?:free|sf|san francisco|202\d)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const datePart = startsAtIso.slice(0, 10);
  return `${datePart}:${cleanTitle}`;
}

/**
 * Infers a San Francisco neighborhood from event title, venue, description, or CSS region classes.
 *
 * @param text - Combined title, venue, and description text.
 * @param classes - Optional CSS classes from Funcheap (`region-*`).
 * @returns Canonical SF neighborhood name or null.
 */
export function inferSfNeighborhood(text: string, classes: string[] = []): string | null {
  for (const [pattern, hood] of SF_NEIGHBORHOOD_PATTERNS) {
    if (pattern.test(text)) return hood;
  }

  for (const cls of classes) {
    if (cls === "region-mission-district") return "Mission";
    if (cls === "region-soma-san-francisco") return "SoMa";
    if (cls === "region-castro") return "Castro";
    if (cls === "region-hayes-valley") return "Hayes Valley";
    if (cls === "region-north-beach") return "North Beach";
    if (cls === "region-golden-gate-park") return "Golden Gate Park";
    if (cls === "region-presidio") return "Presidio";
    if (cls === "region-fort-mason") return "Fort Mason";
    if (cls === "region-marina" || cls === "region-cow-hollow") return "Marina";
    if (cls === "region-sunset-district") return "Sunset";
    if (cls === "region-richmond-district") return "Richmond";
    if (cls === "region-dogpatch") return "Dogpatch";
    if (cls === "region-potrero-hill") return "Potrero Hill";
    if (cls === "region-embarcadero" || cls === "region-fishermans-wharf-san-francisco")
      return "Embarcadero";
    if (cls === "region-chinatown") return "Chinatown";
    if (cls === "region-japantown") return "Japantown";
    if (cls === "region-fillmore-district") return "Fillmore / NOPA";
    if (cls === "region-lower-haight" || cls === "region-haight-ashbury") return "Haight";
    if (cls === "region-nob-hill") return "Nob Hill / Polk";
    if (cls === "region-bernal-heights") return "Bernal Heights";
    if (cls === "region-noe-valley") return "Noe Valley";
    if (cls === "region-mission-bay") return "Mission Bay";
    if (
      cls === "region-downtown-san-francisco" ||
      cls === "region-financial-district" ||
      cls === "region-civic-center" ||
      cls === "category-downtown-san-francisco"
    ) {
      return "Downtown";
    }
  }

  const parenMatch = text.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const inside = parenMatch[1].trim();
    if (
      inside &&
      !/^(?:sf|san francisco|oct\.?.*|nov\.?.*|every .*|\d+.*)$/i.test(inside) &&
      inside.length <= 28
    ) {
      return inside;
    }
  }
  return null;
}

/**
 * Classifies an event into one of the primary or secondary SF categories and extracts rich tags.
 * Prioritizes Food & Drink, Nightlife, and Outdoors (Tier 1) when an event spans multiple categories.
 *
 * @param params - Classification inputs (title, description, classes, rawGenres, venue, neighborhood, isFree, startsAtIso, hintCategory).
 * @returns Primary category, tier (1 or 2), and normalized tag list.
 */
export function classifyAndTagEvent(params: {
  title: string;
  description?: string | null;
  classes?: string[];
  rawGenres?: string[];
  venue?: string | null;
  neighborhood?: string | null;
  isFree: boolean;
  startsAtIso: string;
  hintCategory?: SfEventCategory;
}): { category: SfEventCategory; tier: 1 | 2; tags: string[] } {
  const combined = `${params.title} ${params.description ?? ""} ${(params.rawGenres ?? []).join(" ")}`.toLowerCase();
  const classSet = new Set((params.classes ?? []).map((c) => c.toLowerCase()));
  const tags = new Set<string>();

  const hasExplicitFoodKeyword =
    classSet.has("category-free-food") ||
    classSet.has("category-night-market") ||
    classSet.has("category-brunch") ||
    /\b(?:food|taco|wing|hot dog|margarita|bbq|beer|wine|cocktail|tasting|brunch|dinner|pop-up|night market|farmers market|coffee|bakery|ramen|pizza|dim sum|cook-off|brewery|cidery|eat|feast|boba|ice cream)\b/i.test(
      combined,
    );

  const isOutdoors =
    classSet.has("category-outdoors") ||
    classSet.has("category-nature") ||
    classSet.has("category-walks-tours-event-types-event") ||
    classSet.has("category-block-party") ||
    classSet.has("category-outdoor-movie-night") ||
    /\b(?:outdoor|park|beach|hike|walk|trail|garden|presidio|sunset dunes|golden gate park|street fair|block party|flea market|rooftop|waterfront|kayak|bike|picnic|bonfire|harvest festival|al fresco|pier 39)\b/i.test(
      combined,
    );

  const isNightlife =
    params.hintCategory === "nightlife" ||
    classSet.has("category-club-dj") ||
    classSet.has("category-dance") ||
    classSet.has("category-pub-quiz-trivia-night") ||
    /\b(?:dj|club|dance party|afterparty|nightlife|house music|tech house|deep house|disco|techno|uk garage|rave|21\+|bar crawl|late night|b2b|silent disco|cumbia|trivia|mixer|karaoke)\b/i.test(
      combined,
    );

  const isFood =
    hasExplicitFoodKeyword ||
    (classSet.has("category-eating-drinking") && !isNightlife && !isOutdoors);

  const isComedy =
    params.hintCategory === "comedy" ||
    classSet.has("category-comedy-event-types-event") ||
    /\b(?:comedy|stand-up|standup|improv|comedian)\b/i.test(combined);

  const isMusic =
    params.hintCategory === "music" ||
    classSet.has("category-live-music-event") ||
    /\b(?:concert|live music|symphony|jazz|band|orchestra|brass|acoustic|indie rock|singer)\b/i.test(
      combined,
    );

  const isSports =
    params.hintCategory === "sports" ||
    classSet.has("category-sports-fitness") ||
    /\b(?:run club|5k|10k|marathon|yoga|pickleball|warriors|giants|49ers|valkyries|skate|roller|climbing|trampoline)\b/i.test(
      combined,
    );

  const isArts =
    params.hintCategory === "arts" ||
    classSet.has("category-art-museums") ||
    classSet.has("category-free-museum-day-art-museums-event-types-event") ||
    /\b(?:museum|gallery|art walk|exhibition|sculpture|mural|film|screening|workshop|craft|literary|fashion)\b/i.test(
      combined,
    );

  let category: SfEventCategory = params.hintCategory ?? "arts";
  if (hasExplicitFoodKeyword) category = "food";
  else if (isOutdoors) category = "outdoors";
  else if (isNightlife) category = "nightlife";
  else if (isFood) category = "food";
  else if (isComedy) category = "comedy";
  else if (isMusic) category = "music";
  else if (isSports) category = "sports";
  else if (isArts) category = "arts";

  // Also add secondary category tags when an event crosses verticals (e.g. outdoor night market with DJs!)
  tags.add(`cat:${category}`);
  if (isFood) tags.add("cat:food");
  if (isOutdoors) tags.add("cat:outdoors");
  if (isNightlife) tags.add("cat:nightlife");
  if (isMusic) tags.add("cat:music");
  if (isComedy) tags.add("cat:comedy");
  if (isSports) tags.add("cat:sports");
  if (isArts) tags.add("cat:arts");

  // Fine-grained vibe tags for taste learning
  const vibeMatchers: Array<[RegExp, string]> = [
    [/\b(?:night market|street food|food truck)\b/i, "vibe:night-market"],
    [/\b(?:taco|margarita|mexican|cumbia|mezcal)\b/i, "vibe:latin-food-music"],
    [/\b(?:beer|brewery|lager|ipa|oktoberfest|cider)\b/i, "vibe:craft-beer"],
    [/\b(?:wine|tasting|natural wine|vineyard)\b/i, "vibe:wine-tasting"],
    [/\b(?:coffee|matcha|pastry|bakery|brunch)\b/i, "vibe:daytime-bites"],
    [/\b(?:house|deep house|tech house|funky house|disco)\b/i, "vibe:house-disco"],
    [/\b(?:techno|electro|industrial|acid)\b/i, "vibe:techno"],
    [/\b(?:uk garage|jungle|drum and bass|dnb|dubstep|bass)\b/i, "vibe:bass-garage"],
    [/\b(?:jazz|soul|funk|motown|r&b)\b/i, "vibe:jazz-funk"],
    [/\b(?:live music|band|concert|indie|rock)\b/i, "vibe:live-band"],
    [/\b(?:comedy|improv|stand-up|standup)\b/i, "vibe:comedy"],
    [/\b(?:trivia|pub quiz|games|board game)\b/i, "vibe:trivia-games"],
    [/\b(?:block party|street fair|flea market|festival)\b/i, "vibe:street-festival"],
    [/\b(?:park|beach|garden|hike|walk|tour|nature)\b/i, "vibe:parks-nature"],
    [/\b(?:museum|gallery|art|exhibit|film)\b/i, "vibe:art-museum"],
    [/\b(?:run|bike|yoga|fitness|pickleball|skate)\b/i, "vibe:active-social"],
  ];
  for (const [re, tag] of vibeMatchers) {
    if (re.test(combined)) tags.add(tag);
  }

  for (const g of params.rawGenres ?? []) {
    const cleanG = g
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (cleanG && cleanG.length <= 24) {
      tags.add(`genre:${cleanG}`);
    }
  }

  if (params.neighborhood) {
    const hoodSlug = params.neighborhood
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (hoodSlug) tags.add(`hood:${hoodSlug}`);
  }

  tags.add(params.isFree ? "price:free" : "price:paid");

  // Time-of-day / day-of-week slot tag
  const dt = new Date(params.startsAtIso);
  if (!Number.isNaN(dt.getTime())) {
    const day = dt.getUTCDay();
    const isWeekend = day === 0 || day === 5 || day === 6;
    const hourPt = (dt.getUTCHours() - 7 + 24) % 24;
    if (isWeekend && hourPt >= 18) tags.add("slot:weekend-night");
    else if (isWeekend) tags.add("slot:weekend-day");
    else if (hourPt >= 18) tags.add("slot:weeknight");
    else tags.add("slot:weekday");
  }

  const tier = SF_CATEGORY_META[category].tier;
  return { category, tier, tags: [...tags] };
}

/**
 * Formats an internal tag key (e.g. `vibe:house-disco`, `hood:mission`) into a clean UI badge label.
 *
 * @param tag - Structured tag string.
 * @returns Human-readable badge label.
 */
export function formatTagLabel(tag: string): string {
  const [prefix, rawVal = ""] = tag.split(":");
  const words = rawVal
    .split("-")
    .filter(Boolean)
    .map((w) => (w === "sf" ? "SF" : w === "uk" ? "UK" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  if (prefix === "cat") {
    const meta = SF_CATEGORY_META[rawVal as SfEventCategory];
    return meta ? meta.label : words;
  }
  if (prefix === "hood") return words;
  if (prefix === "vibe") return words;
  if (prefix === "genre") return words;
  if (prefix === "price") return rawVal === "free" ? "Free Entry" : "Ticketed";
  if (prefix === "slot") return words;
  return words || tag;
}

/**
 * Converts a Pacific local date/time string (`YYYY-MM-DD HH:mm`) into an ISO 8601 string.
 *
 * @param raw - Date/time string in `YYYY-MM-DD HH:mm` or `YYYY-MM-DD` format.
 * @returns ISO timestamp string or null if invalid.
 */
export function parsePacificDateTimeToIso(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = "12", mm = "00"] = m;
  const monthNum = Number(mo);
  // Rough DST offset for Pacific Time (-07:00 Mar..Nov, -08:00 Nov..Mar)
  const offset = monthNum >= 3 && monthNum <= 10 ? "-07:00" : "-08:00";
  const iso = `${y}-${mo}-${d}T${hh.padStart(2, "0")}:${mm}:${"00"}${offset}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Default Google Calendar account for one-click event creation. */
export const DEFAULT_GCAL_EMAIL = "matanatr96@gmail.com";

function toGCalUtcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Builds a Google Calendar event creation URL (`action=TEMPLATE`) pre-populated
 * with the SF event's title, start/end timestamps (defaulting to 2 hours when `endsAt`
 * is absent), SF venue/neighborhood location, description + source link, and hardcoded
 * to open in Anush's Google Calendar (`matanatr96@gmail.com` via `authuser` and `src`).
 *
 * @param event - The `SfEvent` to add to Google Calendar.
 * @param calendarEmail - Target Google account / calendar ID (defaults to `matanatr96@gmail.com`).
 * @returns Complete `https://calendar.google.com/calendar/render?...` URL.
 */
export function buildGoogleCalendarUrl(
  event: SfEvent,
  calendarEmail: string = DEFAULT_GCAL_EMAIL,
): string {
  const startDate = new Date(event.startsAt);
  const validStart = Number.isNaN(startDate.getTime()) ? new Date() : startDate;

  let endDate = event.endsAt ? new Date(event.endsAt) : null;
  if (!endDate || Number.isNaN(endDate.getTime()) || endDate.getTime() <= validStart.getTime()) {
    endDate = new Date(validStart.getTime() + 2 * 3600 * 1000);
  }

  const dates = `${toGCalUtcStamp(validStart)}/${toGCalUtcStamp(endDate)}`;

  const locationParts = [
    event.venue,
    event.neighborhood,
    "San Francisco, CA",
  ].filter(Boolean);
  const location = locationParts.join(", ");

  const detailLines = [
    event.description,
    event.priceText ? `Price: ${event.priceText}` : null,
    `Event details: ${event.sourceUrl}`,
  ].filter(Boolean);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    location,
    details: detailLines.join("\n\n"),
    ctz: "America/Los_Angeles",
    authuser: calendarEmail,
    src: calendarEmail,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Parses Funcheap SF calendar/category HTML into normalized `SfEvent` items,
 * filtering out non-SF East Bay / South Bay / Peninsula listings.
 *
 * @param html - Raw HTML from a Funcheap SF listing page.
 * @param hintCategory - Optional category hint from the specific Funcheap category feed URL.
 * @returns Array of parsed `SfEvent` objects.
 */
export function parseFuncheapHtml(
  html: string,
  hintCategory?: SfEventCategory,
): SfEvent[] {
  const results: SfEvent[] = [];
  const blockRegex =
    /<div id="post-(\d+)" class="([^"]+)"[^>]*>([\s\S]*?)(?=<div id="post-\d+"|<div class="navigation"|<\/div><!-- \/content -->|$)/g;

  for (const match of html.matchAll(blockRegex)) {
    const [, postId, classAttr, innerHtml] = match;
    const classes = classAttr.split(/\s+/).filter(Boolean);

    // Skip explicitly non-SF regions
    if (
      classes.some((c) =>
        /^region-(?:east-bay|oakland|berkeley|south-bay|san-jose|peninsula|palo-alto|north-bay|greater-sacramento)$/i.test(
          c,
        ),
      ) &&
      !classes.includes("region-san-francisco")
    ) {
      continue;
    }

    const titleMatch = innerHtml.match(
      /<(?:div|span) class="title entry-title"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!titleMatch) continue;
    const sourceUrl = titleMatch[1].trim();
    const title = stripHtml(titleMatch[2]);
    if (!title || NON_SF_CITIES_REGEX.test(title)) continue;

    const metaMatch = innerHtml.match(
      /<div class="meta[^"]*date-time[^"]*"[^>]*data-event-date="([^"]*)"(?:[^>]*data-event-date-end="([^"]*)")?[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (!metaMatch) continue;

    const startsAt = parsePacificDateTimeToIso(metaMatch[1]);
    if (!startsAt) continue;
    const endsAt = parsePacificDateTimeToIso(metaMatch[2]);
    const metaInner = metaMatch[3];

    // Extract cost and venue from meta bar
    const metaTextParts = stripHtml(
      metaInner.replace(/<div class="tooltip">[\s\S]*?<\/div>/gi, ""),
    )
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);

    let priceText: string | null = null;
    let venue: string | null = null;
    for (const part of metaTextParts) {
      if (/^cost:/i.test(part)) {
        const cleanedCost = part.replace(/^cost:\s*/i, "").replace(/\*+$/, "").trim();
        priceText = cleanedCost || "Free / Varies";
      }
    }
    if (metaTextParts.length >= 3) {
      const candidateVenue = metaTextParts[metaTextParts.length - 1];
      if (!/^cost:/i.test(candidateVenue)) {
        venue = candidateVenue;
      }
    }

    const isFree =
      !priceText ||
      /\bfree\b/i.test(priceText) ||
      /\bfree\b/i.test(title) ||
      classes.includes("category-free-stuff") ||
      classes.includes("category-free-food");

    // Extract image URL from <noscript><img src="..."/></noscript> or <img src="http...">
    const imgMatch =
      innerHtml.match(/<noscript[^>]*>\s*<img[^>]+src="([^"]+)"/i) ??
      innerHtml.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
    const imageUrl = imgMatch ? imgMatch[1].trim() : null;

    // Extract first non-empty paragraph description (skipping ad <script> wrapper paragraphs)
    let rawDesc = "";
    for (const pMatch of innerHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const candidate = stripHtml(pMatch[1]);
      if (candidate && !/^googletag\.cmd\.push/i.test(candidate)) {
        rawDesc = candidate;
        break;
      }
    }
    const description = rawDesc ? rawDesc.slice(0, 280) : null;

    const neighborhood = inferSfNeighborhood(
      `${title} ${venue ?? ""} ${description ?? ""}`,
      classes,
    );

    const { category, tier, tags } = classifyAndTagEvent({
      title,
      description,
      classes,
      venue,
      neighborhood,
      isFree,
      startsAtIso: startsAt,
      hintCategory,
    });

    results.push({
      id: `funcheap:${postId}`,
      source: "funcheap",
      sourceUrl,
      title,
      description,
      category,
      tier,
      startsAt,
      endsAt,
      venue,
      neighborhood,
      priceText: priceText ?? (isFree ? "Free" : null),
      isFree,
      imageUrl,
      tags,
      dedupeKey: buildDedupeKey(title, startsAt),
    });
  }

  return results;
}

/**
 * Parses 19hz.info Bay Area electronic/nightlife/live-music HTML table into `SfEvent` items,
 * filtering specifically to `(San Francisco)` events within the upcoming window.
 *
 * @param html - Raw HTML from `https://19hz.info/eventlisting_BayArea.php`.
 * @param maxDaysAhead - Maximum days in the future to include (default 14).
 * @param now - Reference date for filtering (defaults to current time).
 * @returns Array of parsed `SfEvent` items in San Francisco.
 */
export function parse19hzHtml(
  html: string,
  maxDaysAhead = 14,
  now: Date = new Date(),
): SfEvent[] {
  const results: SfEvent[] = [];
  const tbodyIdx = html.indexOf("<tbody>");
  const slice = tbodyIdx >= 0 ? html.slice(tbodyIdx) : html;
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;

  const minMs = now.getTime() - 12 * 3600 * 1000;
  const maxMs = now.getTime() + maxDaysAhead * 24 * 3600 * 1000;

  for (const rowMatch of slice.matchAll(rowRegex)) {
    const rowHtml = rowMatch[1];
    if (!/\(\s*San Francisco\s*\)/i.test(rowHtml)) continue;

    // Extract machine date YYYY/MM/DD from <div class='shrink'>2026/10/07</div>
    const dateShrink = rowHtml.match(/<div class=['"]shrink['"]>(\d{4})\/(\d{2})\/(\d{2})<\/div>/i);
    if (!dateShrink) continue;
    const [, year, month, day] = dateShrink;

    // Extract time like (9pm-2am) or (7pm)
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)(?=<td|<\/tr>)/gi)].map((m) => m[1]);
    if (cells.length < 4) continue;

    const timeCell = stripHtml(cells[0]);
    let startHour = 21;
    let startMin = 0;
    const timeMatch = timeCell.match(/\((\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let h = Number(timeMatch[1]);
      const m = Number(timeMatch[2] ?? "0");
      const mer = timeMatch[3].toLowerCase();
      if (mer === "pm" && h < 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      startHour = h;
      startMin = m;
    }

    const startsAt = parsePacificDateTimeToIso(
      `${year}-${month}-${day} ${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}`,
    );
    if (!startsAt) continue;
    const startMs = new Date(startsAt).getTime();
    if (startMs < minMs || startMs > maxMs) continue;

    // Title, link, and venue from cells[1]
    const titleCell = cells[1];
    const linkMatch = titleCell.match(/<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const sourceUrl = linkMatch[1].trim();
    const title = stripHtml(linkMatch[2]);
    if (!title) continue;

    const afterLink = stripHtml(titleCell.replace(/<a[\s\S]*?<\/a>/i, ""));
    const venueMatch = afterLink.match(/@\s*([^()]+)\(\s*San Francisco\s*\)/i);
    const venue = venueMatch ? venueMatch[1].trim() : null;

    const genresRaw = stripHtml(cells[2]);
    const rawGenres = genresRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const priceAgeRaw = stripHtml(cells[3]);
    const isFree = /\bfree\b/i.test(priceAgeRaw);
    const promoter = cells[4] ? stripHtml(cells[4]) : "";

    const descriptionParts = [
      rawGenres.length > 0 ? `Genres: ${rawGenres.join(", ")}` : null,
      promoter ? `Presented by ${promoter}` : null,
      priceAgeRaw ? `Admission: ${priceAgeRaw}` : null,
    ].filter(Boolean);
    const description = descriptionParts.join(" · ") || null;

    const neighborhood = inferSfNeighborhood(`${title} ${venue ?? ""}`);
    const { category, tier, tags } = classifyAndTagEvent({
      title,
      description,
      rawGenres,
      venue,
      neighborhood,
      isFree,
      startsAtIso: startsAt,
      hintCategory: "nightlife",
    });

    const slug = `${year}-${month}-${day}-${title}-${venue ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

    results.push({
      id: `19hz:${slug}`,
      source: "19hz",
      sourceUrl,
      title,
      description,
      category,
      tier,
      startsAt,
      endsAt: null,
      venue,
      neighborhood,
      priceText: priceAgeRaw || null,
      isFree,
      imageUrl: null,
      tags,
      dedupeKey: buildDedupeKey(title, startsAt),
    });
  }

  return results;
}

/**
 * Parses SF Station RSS XML feed items into `SfEvent` objects, skipping ticket giveaway spam.
 *
 * @param xml - Raw RSS XML string from `https://www.sfstation.com/feed/`.
 * @returns Array of parsed `SfEvent` objects.
 */
export function parseSfStationRss(xml: string): SfEvent[] {
  const results: SfEvent[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;

  for (const match of xml.matchAll(itemRegex)) {
    const itemXml = match[1];
    const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    if (!titleMatch || !linkMatch) continue;

    const title = stripHtml(titleMatch[1]);
    const sourceUrl = linkMatch[1].trim();
    if (!title || /^win tickets\b/i.test(title)) continue;

    const categories = [...itemXml.matchAll(/<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>/gi)].map(
      (m) => decodeHtmlEntities(m[1].trim()),
    );
    if (categories.some((c) => /^giveaway$/i.test(c))) continue;

    const descMatch = itemXml.match(
      /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i,
    );
    const description = descMatch ? stripHtml(descMatch[1]).slice(0, 280) : null;

    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const pubDate = pubDateMatch ? new Date(pubDateMatch[1].trim()) : new Date();
    const startsAt = Number.isNaN(pubDate.getTime())
      ? new Date().toISOString()
      : pubDate.toISOString();

    const mediaMatch = itemXml.match(/<(?:enclosure|media:content)[^>]+url="([^"]+)"/i);
    const imageUrl = mediaMatch ? mediaMatch[1].trim() : null;

    const isFree =
      categories.some((c) => /free/i.test(c)) ||
      /\bfree\b/i.test(title) ||
      /\bfree\b/i.test(description ?? "");

    const neighborhood = inferSfNeighborhood(`${title} ${description ?? ""} ${categories.join(" ")}`);
    const { category, tier, tags } = classifyAndTagEvent({
      title,
      description,
      rawGenres: categories,
      neighborhood,
      isFree,
      startsAtIso: startsAt,
    });

    const slug = sourceUrl
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

    results.push({
      id: `sfstation:${slug}`,
      source: "sfstation",
      sourceUrl,
      title,
      description,
      category,
      tier,
      startsAt,
      endsAt: null,
      venue: null,
      neighborhood,
      priceText: isFree ? "Free" : null,
      isFree,
      imageUrl,
      tags,
      dedupeKey: buildDedupeKey(title, startsAt),
    });
  }

  return results;
}

/**
 * Deduplicates an array of `SfEvent` items by `id` and `dedupeKey`, merging tags
 * and preserving richer metadata (descriptions, images, venues, and Tier 1 categories).
 *
 * @param events - Raw list of `SfEvent` items across sources and category feeds.
 * @returns Deduplicated array of `SfEvent` items sorted chronologically by `startsAt`.
 */
export function dedupeSfEvents(events: SfEvent[]): SfEvent[] {
  const byKey = new Map<string, SfEvent>();

  for (const ev of events) {
    const existing = byKey.get(ev.dedupeKey);
    if (!existing) {
      byKey.set(ev.dedupeKey, { ...ev, tags: [...new Set(ev.tags)] });
      continue;
    }

    const mergedTags = [...new Set([...existing.tags, ...ev.tags])];
    // Prefer Tier 1 category if one of the duplicate entries came from a Tier 1 category feed
    const preferIncomingCategory = existing.tier > ev.tier;
    const category = preferIncomingCategory ? ev.category : existing.category;
    const tier = preferIncomingCategory ? ev.tier : existing.tier;

    byKey.set(ev.dedupeKey, {
      ...existing,
      category,
      tier,
      description:
        (existing.description?.length ?? 0) >= (ev.description?.length ?? 0)
          ? existing.description
          : ev.description,
      venue: existing.venue ?? ev.venue,
      neighborhood: existing.neighborhood ?? ev.neighborhood,
      priceText: existing.priceText ?? ev.priceText,
      imageUrl: existing.imageUrl ?? ev.imageUrl,
      tags: mergedTags,
    });
  }

  return [...byKey.values()].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}

/**
 * Builds a user's `TasteProfile` from their historical `SfEventFeedback` signals.
 * - `up` (+1.0): Strongly boosts the event's category, vibe, neighborhood, and time slot tags.
 * - `busy` (+0.2): Gently boosts the event's tags ("good vibe, bad timing") while dismissing the specific date.
 * - `down` (-1.0): Penalizes the event's tags.
 *
 * @param feedbackList - Recorded feedback items.
 * @returns Aggregated `TasteProfile` with tag weights and top liked/avoided tag summaries.
 */
export function buildTasteProfile(feedbackList: SfEventFeedback[]): TasteProfile {
  const tagWeights: Record<string, number> = {};
  let upCount = 0;
  let busyCount = 0;
  let downCount = 0;

  for (const fb of feedbackList) {
    const delta = SIGNAL_WEIGHTS[fb.signal] ?? 0;
    if (fb.signal === "up") upCount++;
    else if (fb.signal === "busy") busyCount++;
    else if (fb.signal === "down") downCount++;

    for (const tag of fb.tagsSnapshot ?? []) {
      // Weight specific vibe/genre/neighborhood tags slightly higher than broad price/slot tags
      const multiplier =
        tag.startsWith("vibe:") || tag.startsWith("genre:")
          ? 1.25
          : tag.startsWith("hood:") || tag.startsWith("cat:")
            ? 1.0
            : 0.5;
      tagWeights[tag] = (tagWeights[tag] ?? 0) + delta * multiplier;
    }
  }

  const displayableEntries = Object.entries(tagWeights).filter(
    ([tag]) =>
      tag.startsWith("vibe:") ||
      tag.startsWith("genre:") ||
      tag.startsWith("hood:") ||
      tag.startsWith("cat:"),
  );

  const topLikedTags = displayableEntries
    .filter(([, w]) => w >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, weight]) => ({ tag, label: formatTagLabel(tag), weight }));

  const topAvoidedTags = displayableEntries
    .filter(([, w]) => w <= -0.5)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([tag, weight]) => ({ tag, label: formatTagLabel(tag), weight }));

  return {
    tagWeights,
    upCount,
    busyCount,
    downCount,
    topLikedTags,
    topAvoidedTags,
  };
}

/**
 * Computes a personalized relevance score and human-readable explanation chips for a single `SfEvent`.
 *
 * @param event - Candidate `SfEvent`.
 * @param profile - Aggregated `TasteProfile` from user votes.
 * @param userSignal - Current user vote on this specific event (`up` | `busy` | `down` | `null`).
 * @param now - Reference timestamp for recency/immediacy scoring.
 * @returns `RankedSfEvent` with numerical score and explanation reasons.
 */
export function scoreSfEvent(
  event: SfEvent,
  profile: TasteProfile,
  userSignal: SfVoteSignal | null = null,
  now: Date = new Date(),
): RankedSfEvent {
  const meta = SF_CATEGORY_META[event.category];
  let score = meta.baseScore;
  const reasons: string[] = [];

  if (event.tier === 1) {
    reasons.push(`Top tier: ${meta.label}`);
  }

  // Time proximity boost (happening within next 72 hours gets a boost)
  const hoursUntil = (new Date(event.startsAt).getTime() - now.getTime()) / (3600 * 1000);
  if (hoursUntil >= -4 && hoursUntil <= 24) {
    score += 1.1;
    reasons.push("Happening today");
  } else if (hoursUntil > 24 && hoursUntil <= 72) {
    score += 0.65;
    reasons.push("This week");
  } else if (hoursUntil > 72 && hoursUntil <= 168) {
    score += 0.3;
  }

  if (event.isFree) {
    score += 0.35;
  }

  // Tag-affinity contribution with damped logarithmic scaling per tag
  const matchedPositiveTags: Array<{ tag: string; contrib: number }> = [];
  let negativePenalty = 0;

  for (const tag of event.tags) {
    const rawW = profile.tagWeights[tag] ?? 0;
    if (rawW === 0) continue;
    const damped = Math.sign(rawW) * Math.log1p(Math.abs(rawW)) * 1.15;
    score += damped;
    if (damped > 0.35 && !tag.startsWith("price:") && !tag.startsWith("slot:")) {
      matchedPositiveTags.push({ tag, contrib: damped });
    } else if (damped < -0.35) {
      negativePenalty += damped;
    }
  }

  matchedPositiveTags.sort((a, b) => b.contrib - a.contrib);
  for (const m of matchedPositiveTags.slice(0, 2)) {
    reasons.push(`Matches liked: ${formatTagLabel(m.tag)}`);
  }

  if (negativePenalty < -0.8 && matchedPositiveTags.length === 0) {
    reasons.push("Similar to passed events");
  }

  // Direct vote override on the specific event
  if (userSignal === "up") {
    score += 2.5;
  } else if (userSignal === "down") {
    score -= 6.0;
  }

  return {
    event,
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 3),
    userSignal,
  };
}

/**
 * Ranks a list of `SfEvent` items using the v1 tag-affinity algorithm and injects
 * periodic wildcard discovery picks (every 6th slot) from under-represented categories.
 *
 * @param events - Candidate `SfEvent` list.
 * @param feedbackMap - Map or Record of `eventId -> SfEventFeedback`.
 * @param now - Reference date for scoring.
 * @returns Ranked list of `RankedSfEvent` objects and the computed `TasteProfile`.
 */
export function rankSfEvents(
  events: SfEvent[],
  feedbackMap: Record<string, SfEventFeedback>,
  now: Date = new Date(),
): { ranked: RankedSfEvent[]; profile: TasteProfile } {
  const feedbackList = Object.values(feedbackMap);
  const profile = buildTasteProfile(feedbackList);

  const scored = events
    .map((ev) => {
      const fb = feedbackMap[ev.id];
      return scoreSfEvent(ev, profile, fb?.signal ?? null, now);
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime();
    });

  // Interleave a wildcard discovery pick at every 6th position (index 5, 11, 17...)
  // from lower-tier or less-voted categories so the feed never becomes a narrow echo chamber.
  const activePool = scored.filter(
    (item) => item.userSignal !== "down" && item.userSignal !== "busy",
  );
  const dismissedPool = scored.filter(
    (item) => item.userSignal === "down" || item.userSignal === "busy",
  );

  const primaryQueue = [...activePool];
  const finalActive: RankedSfEvent[] = [];

  while (primaryQueue.length > 0) {
    // Every 6th slot (when finalActive.length % 6 === 5), look for an interesting wildcard
    if (finalActive.length % 6 === 5 && primaryQueue.length > 3) {
      const recentCategories = new Set(finalActive.slice(-4).map((x) => x.event.category));
      const wildcardIdx = primaryQueue.findIndex(
        (candidate, idx) => idx > 1 && !recentCategories.has(candidate.event.category),
      );
      if (wildcardIdx > 1) {
        const [wildcard] = primaryQueue.splice(wildcardIdx, 1);
        finalActive.push({
          ...wildcard,
          isWildcard: true,
          reasons: ["Wildcard discovery", ...wildcard.reasons.slice(0, 2)],
        });
        continue;
      }
    }

    // Category diversity rotation: if the last 2 items share the same category as primaryQueue[0],
    // pick the highest-scoring candidate from a different category within 0.25 score points.
    const prevCat = finalActive[finalActive.length - 1]?.event.category;
    const headScore = primaryQueue[0].score;
    const diverseIdx = primaryQueue.findIndex(
      (c) => c.event.category !== prevCat && headScore - c.score <= 0.25,
    );
    if (diverseIdx > 0) {
      const [chosen] = primaryQueue.splice(diverseIdx, 1);
      finalActive.push(chosen);
      continue;
    }

    const next = primaryQueue.shift();
    if (next) finalActive.push(next);
  }

  return {
    ranked: [...finalActive, ...dismissedPool],
    profile,
  };
}

const FUNCHEAP_FEEDS: Array<{ path: string; hintCategory?: SfEventCategory }> = [
  { path: "/today/" },
  { path: "/tomorrow/" },
  { path: "/weekend/" },
  { path: "/category/event/event-types/eating-drinking/", hintCategory: "food" },
  { path: "/category/event/event-types/outdoors/", hintCategory: "outdoors" },
  { path: "/category/event/event-types/fairs-festivals/", hintCategory: "outdoors" },
  { path: "/category/event/event-types/club-dj/", hintCategory: "nightlife" },
  { path: "/category/event/event-types/live-music-event/", hintCategory: "music" },
  { path: "/category/event/event-types/comedy-event-types-event/", hintCategory: "comedy" },
];

let _liveCache: { expiresAt: number; events: SfEvent[] } | null = null;

/**
 * Fetches live upcoming San Francisco events directly from free zero-key sources
 * (Funcheap SF category/daily feeds, 19hz.info SF nightlife table, and SF Station RSS).
 * Uses a 20-minute in-memory cache to keep page loads fast.
 *
 * @param forceRefresh - When true, bypasses the in-memory cache.
 * @returns Deduplicated upcoming `SfEvent` list and per-source counts/errors.
 */
export async function fetchLiveSfEventsFromSources(forceRefresh = false): Promise<{
  events: SfEvent[];
  bySource: Record<string, number>;
  errors: string[];
}> {
  if (!forceRefresh && _liveCache && Date.now() < _liveCache.expiresAt) {
    return {
      events: _liveCache.events,
      bySource: { cached: _liveCache.events.length },
      errors: [],
    };
  }

  const errors: string[] = [];
  const bySource: Record<string, number> = {
    funcheap: 0,
    "19hz": 0,
    sfstation: 0,
  };
  const collected: SfEvent[] = [];

  // 1. Fetch Funcheap SF feeds in parallel
  const funcheapTasks = FUNCHEAP_FEEDS.map(async ({ path, hintCategory }) => {
    try {
      const res = await fetch(`https://sf.funcheap.com${path}`, {
        next: { revalidate: 1800 },
      });
      if (!res.ok) {
        errors.push(`Funcheap ${path}: HTTP ${res.status}`);
        return [];
      }
      const html = await res.text();
      return parseFuncheapHtml(html, hintCategory);
    } catch (e) {
      errors.push(`Funcheap ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  });

  // 2. Fetch 19hz.info Bay Area Nightlife / Electronic / Live Music table
  const hzTask = (async () => {
    try {
      const res = await fetch("https://19hz.info/eventlisting_BayArea.php", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; thelastmattapalli/1.0)" },
        next: { revalidate: 1800 },
      });
      if (!res.ok) {
        errors.push(`19hz: HTTP ${res.status}`);
        return [];
      }
      const html = await res.text();
      return parse19hzHtml(html, 14);
    } catch (e) {
      errors.push(`19hz: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  })();

  // 3. Fetch SF Station RSS feed
  const sfStationTask = (async () => {
    try {
      const res = await fetch("https://www.sfstation.com/feed/", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; thelastmattapalli/1.0)" },
        next: { revalidate: 1800 },
      });
      if (!res.ok) {
        errors.push(`SF Station: HTTP ${res.status}`);
        return [];
      }
      const xml = await res.text();
      return parseSfStationRss(xml);
    } catch (e) {
      errors.push(`SF Station: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  })();

  const [funcheapLists, hzEvents, sfStationEvents] = await Promise.all([
    Promise.all(funcheapTasks),
    hzTask,
    sfStationTask,
  ]);

  const funcheapFlat = funcheapLists.flat();
  bySource.funcheap = funcheapFlat.length;
  bySource["19hz"] = hzEvents.length;
  bySource.sfstation = sfStationEvents.length;

  collected.push(...funcheapFlat, ...hzEvents, ...sfStationEvents);

  // Filter out past events older than 6 hours ago
  const cutoffMs = Date.now() - 6 * 3600 * 1000;
  const upcoming = dedupeSfEvents(collected).filter(
    (ev) => new Date(ev.startsAt).getTime() >= cutoffMs,
  );

  if (upcoming.length > 0) {
    _liveCache = {
      expiresAt: Date.now() + 20 * 60 * 1000,
      events: upcoming,
    };
  }

  return { events: upcoming, bySource, errors };
}

interface DbSfEventRow {
  id: string;
  source: "funcheap" | "19hz" | "sfstation" | "ticketmaster";
  source_url: string;
  title: string;
  description: string | null;
  category: SfEventCategory;
  tier: number;
  starts_at: string;
  ends_at: string | null;
  venue: string | null;
  neighborhood: string | null;
  price_text: string | null;
  is_free: boolean;
  image_url: string | null;
  tags: string[] | null;
  dedupe_key: string;
}

function rowToSfEvent(r: DbSfEventRow): SfEvent {
  return {
    id: r.id,
    source: r.source,
    sourceUrl: r.source_url,
    title: r.title,
    description: r.description,
    category: r.category,
    tier: r.tier === 1 ? 1 : 2,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    venue: r.venue,
    neighborhood: r.neighborhood,
    priceText: r.price_text,
    isFree: r.is_free,
    imageUrl: r.image_url,
    tags: r.tags ?? [],
    dedupeKey: r.dedupe_key,
  };
}

/**
 * Syncs live SF events from all sources and upserts them into the Supabase `sf_events` table.
 * Gracefully succeeds and returns the live-fetched counts even if the `sf_events` migration
 * has not been applied yet.
 *
 * @returns Summary of fetched, deduplicated, and persisted events.
 */
export async function syncSfEventsToDb(): Promise<SfSyncSummary> {
  const { events, bySource, errors } = await fetchLiveSfEventsFromSources(true);
  const fetched = Object.values(bySource).reduce((a, b) => a + b, 0);

  let persistedToDb = false;
  try {
    const db = getServiceClient();
    const rows = events.map((ev) => ({
      id: ev.id,
      source: ev.source,
      source_url: ev.sourceUrl,
      title: ev.title,
      description: ev.description,
      category: ev.category,
      tier: ev.tier,
      starts_at: ev.startsAt,
      ends_at: ev.endsAt,
      venue: ev.venue,
      neighborhood: ev.neighborhood,
      price_text: ev.priceText,
      is_free: ev.isFree,
      image_url: ev.imageUrl,
      tags: ev.tags,
      dedupe_key: ev.dedupeKey,
      synced_at: new Date().toISOString(),
    }));

    if (rows.length > 0) {
      const { error } = await db.from("sf_events").upsert(rows, { onConflict: "id" });
      if (error) {
        errors.push(`Supabase upsert: ${error.message}`);
      } else {
        persistedToDb = true;
      }
    }
  } catch (e) {
    errors.push(`Supabase client: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    fetched,
    deduped: events.length,
    persistedToDb,
    bySource,
    errors,
  };
}

/**
 * Loads upcoming SF events and saved user feedback from Supabase, falling back seamlessly
 * to live-fetched SF events if the `sf_events` table is empty or not yet migrated.
 *
 * @returns Upcoming `SfEvent` array and feedback map keyed by `eventId`.
 */
export async function loadSfEventsAndFeedback(): Promise<{
  events: SfEvent[];
  feedbackMap: Record<string, SfEventFeedback>;
}> {
  let events: SfEvent[] = [];
  const feedbackMap: Record<string, SfEventFeedback> = {};

  try {
    const supabase = getSupabase();
    const cutoffIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

    const [eventsRes, fbRes] = await Promise.all([
      supabase
        .from("sf_events")
        .select("*")
        .gte("starts_at", cutoffIso)
        .order("starts_at", { ascending: true })
        .limit(200),
      supabase
        .from("sf_event_feedback")
        .select("event_id, signal, tags_snapshot, event_title, updated_at")
        .order("updated_at", { ascending: false })
        .limit(500),
    ]);

    if (!eventsRes.error && eventsRes.data && eventsRes.data.length > 0) {
      events = dedupeSfEvents((eventsRes.data as DbSfEventRow[]).map(rowToSfEvent));
    }

    if (!fbRes.error && fbRes.data) {
      for (const row of fbRes.data) {
        if (row.signal === "up" || row.signal === "down" || row.signal === "busy") {
          feedbackMap[row.event_id] = {
            eventId: row.event_id,
            signal: row.signal,
            tagsSnapshot: Array.isArray(row.tags_snapshot) ? row.tags_snapshot : [],
            eventTitle: row.event_title ?? null,
            updatedAt: row.updated_at,
          };
        }
      }
    }
  } catch {
    // Fall back to live source fetch below
  }

  if (events.length === 0) {
    const live = await fetchLiveSfEventsFromSources(false);
    events = live.events;
  }

  return { events, feedbackMap };
}
