import { describe, expect, it } from "vitest";
import {
  buildDedupeKey,
  buildTasteProfile,
  classifyAndTagEvent,
  decodeHtmlEntities,
  dedupeSfEvents,
  inferSfNeighborhood,
  parse19hzHtml,
  parseFuncheapHtml,
  parseSfStationRss,
  rankSfEvents,
  type SfEvent,
  type SfEventFeedback,
} from "../sf-events";

describe("sf-events helpers & parsers", () => {
  it("decodes numeric and named HTML entities cleanly", () => {
    expect(
      decodeHtmlEntities(
        "SF&#8217;s &#8220;Disco Taco Tuesday&#8221; &#038; Margaritas &#150; SoMa",
      ),
    ).toBe("SF’s “Disco Taco Tuesday” & Margaritas – SoMa");
  });

  it("infers SF neighborhoods from venue/title text and region classes", () => {
    expect(inferSfNeighborhood("$1 Wing Wednesdays at Underdogs Cantina (SoMa)", ["category-downtown-san-francisco"])).toBe("SoMa");
    expect(inferSfNeighborhood("Papa Lu @ F8 1192 Folsom (San Francisco)")).toBe("SoMa");
    expect(inferSfNeighborhood("Cumbia Night at Public Works")).toBe("Mission");
    expect(inferSfNeighborhood("Sunset Dunes Beach Dance", ["region-sunset-district"])).toBe("Sunset");
  });

  it("classifies Food, Nightlife, and Outdoors as Tier 1 and others as Tier 2", () => {
    const food = classifyAndTagEvent({
      title: "Mission Night Market & Street Taco Pop-Up",
      neighborhood: "Mission",
      isFree: true,
      startsAtIso: "2026-10-09T02:00:00.000Z",
    });
    expect(food.category).toBe("food");
    expect(food.tier).toBe(1);
    expect(food.tags).toContain("cat:food");
    expect(food.tags).toContain("vibe:night-market");
    expect(food.tags).toContain("hood:mission");

    const outdoors = classifyAndTagEvent({
      title: "Golden Gate Park Botanical Garden Sunset Walk",
      neighborhood: "Golden Gate Park",
      isFree: true,
      startsAtIso: "2026-10-10T20:00:00.000Z",
    });
    expect(outdoors.category).toBe("outdoors");
    expect(outdoors.tier).toBe(1);

    const comedy = classifyAndTagEvent({
      title: "Friday Stand-Up Comedy Showcase",
      neighborhood: "North Beach",
      isFree: false,
      startsAtIso: "2026-10-10T03:00:00.000Z",
    });
    expect(comedy.category).toBe("comedy");
    expect(comedy.tier).toBe(2);
  });

  it("parses Funcheap SF HTML and filters out non-SF East Bay / Peninsula events", () => {
    const sampleHtml = `
      <div id="post-101" class="tanbox left post-101 post category-eating-drinking category-outdoors region-san-francisco">
        <span class="title entry-title"><a href="https://sf.funcheap.com/alemany-harvest/">Alemany Farm Harvest BBQ &#038; Tours (SF)</a></span>
        <div class="meta archive-meta date-time" data-event-date="2026-10-10 11:00" data-event-date-end="2026-10-10 15:00">
          Saturday, October 10 &#150; <span class="fc-event-start-time">11:00 am</span> | <span class="cost">Cost: FREE</span> | <span>Alemany Farm</span>
        </div>
        <p>Free community BBQ, live music, and farm tours in San Francisco.</p>
      </div>
      <div id="post-102" class="tanbox left post-102 post category-eating-drinking region-east-bay">
        <span class="title entry-title"><a href="https://sf.funcheap.com/oakland-fest/">Oakland Taco Fiesta (Oakland)</a></span>
        <div class="meta archive-meta date-time" data-event-date="2026-10-10 12:00">
          Saturday, October 10 | <span class="cost">Cost: FREE</span> | <span>Temescal</span>
        </div>
        <p>East Bay event that should be filtered out.</p>
      </div>
    `;

    const parsed = parseFuncheapHtml(sampleHtml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("funcheap:101");
    expect(parsed[0].title).toBe("Alemany Farm Harvest BBQ & Tours (SF)");
    expect(parsed[0].category).toBe("food");
    expect(parsed[0].tier).toBe(1);
    expect(parsed[0].venue).toBe("Alemany Farm");
    expect(parsed[0].neighborhood).toBe("Bernal Heights");
    expect(parsed[0].isFree).toBe(true);
  });

  it("parses 19hz Bay Area table rows and keeps only San Francisco events in window", () => {
    const now = new Date("2026-10-07T18:00:00.000Z");
    const sample19hz = `
      <tbody>
        <tr>
          <td>Wed: Oct 7 <br />(9pm-2am)</td>
          <td><a href='https://ra.co/events/1'>Papa Lu, Ledet</a> @ F8 1192 Folsom (San Francisco)</td>
          <td>deep house, tech house, disco</td>
          <td>free w/rsvp b4 11pm / $10 | 21+</td>
          <td>Strut</td>
          <td></td>
          <td><div class='shrink'>2026/10/07</div></td>
        </tr>
        <tr>
          <td>Wed: Oct 7 <br />(9pm-1am)</td>
          <td><a href='https://ra.co/events/2'>Bass Night</a> @ MOTIV (Santa Cruz)</td>
          <td>dubstep, bass</td>
          <td>free | 21+</td>
          <td>Crew</td>
          <td></td>
          <td><div class='shrink'>2026/10/07</div></td>
        </tr>
      </tbody>
    `;

    const events = parse19hzHtml(sample19hz, 14, now);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Papa Lu, Ledet");
    expect(events[0].venue).toBe("F8 1192 Folsom");
    expect(events[0].neighborhood).toBe("SoMa");
    expect(events[0].category).toBe("nightlife");
    expect(events[0].isFree).toBe(true);
    expect(events[0].tags).toContain("vibe:house-disco");
  });

  it("parses SF Station RSS and skips ticket giveaways", () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Win Tickets to see Foreigner</title>
          <link>https://www.sfstation.com/giveaway</link>
          <category><![CDATA[Giveaway]]></category>
        </item>
        <item>
          <title><![CDATA[North Beach Night Market & Wine Walk]]></title>
          <link>https://www.sfstation.com/north-beach-wine-walk</link>
          <pubDate>Fri, 09 Oct 2026 19:00:00 +0000</pubDate>
          <category><![CDATA[Food & Wine]]></category>
          <description><![CDATA[Sample local wines and street food along Columbus Ave in North Beach.]]></description>
        </item>
      </channel></rss>
    `;
    const events = parseSfStationRss(xml);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("North Beach Night Market & Wine Walk");
    expect(events[0].category).toBe("food");
    expect(events[0].neighborhood).toBe("North Beach");
  });

  it("deduplicates identical events across sources and merges their tags", () => {
    const startsAt = "2026-10-10T18:00:00.000Z";
    const key = buildDedupeKey("Fleet Week at PIER 39", startsAt);
    const ev1: SfEvent = {
      id: "funcheap:1",
      source: "funcheap",
      sourceUrl: "https://sf.funcheap.com/fleet-week/",
      title: "Fleet Week at PIER 39 (Oct. 7-11)",
      description: "Live music on the waterfront.",
      category: "music",
      tier: 2,
      startsAt,
      endsAt: null,
      venue: null,
      neighborhood: null,
      priceText: "FREE",
      isFree: true,
      imageUrl: null,
      tags: ["cat:music"],
      dedupeKey: key,
    };
    const ev2: SfEvent = {
      ...ev1,
      id: "funcheap:2",
      category: "outdoors",
      tier: 1,
      venue: "Pier 39",
      neighborhood: "Embarcadero",
      tags: ["cat:outdoors", "hood:embarcadero"],
    };

    const deduped = dedupeSfEvents([ev1, ev2]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].category).toBe("outdoors");
    expect(deduped[0].tier).toBe(1);
    expect(deduped[0].venue).toBe("Pier 39");
    expect(deduped[0].tags).toEqual(
      expect.arrayContaining(["cat:music", "cat:outdoors", "hood:embarcadero"]),
    );
  });
});

describe("sf-events taste profile & ranking engine", () => {
  const now = new Date("2026-10-07T18:00:00.000Z");

  const makeEvent = (overrides: Partial<SfEvent> & { id: string; title: string }): SfEvent => ({
    source: "funcheap",
    sourceUrl: `https://example.com/${overrides.id}`,
    description: null,
    category: "food",
    tier: 1,
    startsAt: "2026-10-08T02:00:00.000Z",
    endsAt: null,
    venue: "Venue",
    neighborhood: "Mission",
    priceText: "FREE",
    isFree: true,
    imageUrl: null,
    tags: ["cat:food", "hood:mission", "price:free"],
    dedupeKey: `${overrides.id}-key`,
    ...overrides,
  });

  it("ranks Tier 1 categories (food, nightlife, outdoors) above Tier 2 on cold start", () => {
    const foodEvent = makeEvent({
      id: "ev-food",
      title: "Mission Street Tacos",
      category: "food",
      tier: 1,
    });
    const artsEvent = makeEvent({
      id: "ev-arts",
      title: "Sculpture Gallery Talk",
      category: "arts",
      tier: 2,
      tags: ["cat:arts", "hood:mission"],
    });

    const { ranked } = rankSfEvents([artsEvent, foodEvent], {}, now);
    expect(ranked[0].event.id).toBe("ev-food");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("boosts events sharing tags with 👍 ('up') votes and penalizes 👎 ('down') tags", () => {
    const houseNight1 = makeEvent({
      id: "house-1",
      title: "House DJ Night 1",
      category: "nightlife",
      tier: 1,
      tags: ["cat:nightlife", "vibe:house-disco", "hood:soma"],
    });
    const houseNight2 = makeEvent({
      id: "house-2",
      title: "House DJ Night 2",
      category: "nightlife",
      tier: 1,
      tags: ["cat:nightlife", "vibe:house-disco", "hood:soma"],
    });
    const triviaNight = makeEvent({
      id: "trivia-1",
      title: "Pub Trivia Night",
      category: "nightlife",
      tier: 1,
      tags: ["cat:nightlife", "vibe:trivia-games", "hood:marina"],
    });

    const feedback: Record<string, SfEventFeedback> = {
      "house-1": {
        eventId: "house-1",
        signal: "up",
        tagsSnapshot: ["cat:nightlife", "vibe:house-disco", "hood:soma"],
        updatedAt: now.toISOString(),
      },
      "past-trivia": {
        eventId: "past-trivia",
        signal: "down",
        tagsSnapshot: ["cat:nightlife", "vibe:trivia-games", "hood:marina"],
        updatedAt: now.toISOString(),
      },
    };

    const { ranked, profile } = rankSfEvents(
      [triviaNight, houseNight2, houseNight1],
      feedback,
      now,
    );

    expect(profile.upCount).toBe(1);
    expect(profile.downCount).toBe(1);
    expect(profile.topLikedTags.map((t) => t.tag)).toContain("vibe:house-disco");
    expect(profile.topAvoidedTags.map((t) => t.tag)).toContain("vibe:trivia-games");

    const house2Ranked = ranked.find((r) => r.event.id === "house-2")!;
    const triviaRanked = ranked.find((r) => r.event.id === "trivia-1")!;
    expect(house2Ranked.score).toBeGreaterThan(triviaRanked.score);
    expect(house2Ranked.reasons).toContain("Matches liked: House Disco");
  });

  it("handles 'busy' signal by dismissing the specific event without penalizing its tags", () => {
    const busyOutdoorEvent = makeEvent({
      id: "outdoor-busy",
      title: "Presidio Sunset Hike (Busy Friday)",
      category: "outdoors",
      tier: 1,
      tags: ["cat:outdoors", "vibe:parks-nature", "hood:presidio"],
    });
    const nextDayOutdoorEvent = makeEvent({
      id: "outdoor-sat",
      title: "Presidio Saturday Morning Trail Walk",
      category: "outdoors",
      tier: 1,
      tags: ["cat:outdoors", "vibe:parks-nature", "hood:presidio"],
    });

    const feedback: Record<string, SfEventFeedback> = {
      "outdoor-busy": {
        eventId: "outdoor-busy",
        signal: "busy",
        tagsSnapshot: busyOutdoorEvent.tags,
        updatedAt: now.toISOString(),
      },
    };

    const profile = buildTasteProfile(Object.values(feedback));
    expect(profile.busyCount).toBe(1);
    // Tags receive a positive (+0.2 * multiplier) nudge rather than a negative penalty
    expect(profile.tagWeights["vibe:parks-nature"]).toBeGreaterThan(0);

    const { ranked } = rankSfEvents(
      [busyOutdoorEvent, nextDayOutdoorEvent],
      feedback,
      now,
    );
    // Active event comes first; busy event is moved to the dismissed tail
    expect(ranked[0].event.id).toBe("outdoor-sat");
    expect(ranked[1].event.id).toBe("outdoor-busy");
    expect(ranked[1].userSignal).toBe("busy");
  });
});
