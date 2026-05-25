"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
} from "@vis.gl/react-google-maps";
import type { Restaurant } from "@/lib/types";
import { fmt, ratingColorClass } from "@/lib/utils";

type Props = {
  restaurants: Restaurant[];
  apiKey: string;
};

// Restaurants without coordinates can't be shown — caller already filters,
// but narrow the type here for the markers.
type Geolocated = Restaurant & { lat: number; lng: number };

function pinColor(overall: number): string {
  if (overall >= 9) return "#059669"; // emerald-600
  if (overall >= 8) return "#10b981"; // emerald-500
  if (overall >= 7) return "#65a30d"; // lime-600
  if (overall >= 6) return "#d97706"; // amber-600
  if (overall >= 5) return "#ea580c"; // orange-600
  return "#dc2626"; // red-600
}

function fitToPoints(map: google.maps.Map, pts: Geolocated[]) {
  if (pts.length === 0) return;
  const bounds = new google.maps.LatLngBounds();
  for (const p of pts) bounds.extend({ lat: p.lat, lng: p.lng });
  map.fitBounds(bounds, 64);
}

function FitBounds({
  points,
  initialPoints,
  filterKey,
}: {
  points: Geolocated[];
  initialPoints: Geolocated[];
  filterKey: string;
}) {
  const map = useMap();
  const [didInitialFit, setDidInitialFit] = useState(false);
  useEffect(() => {
    if (!map || didInitialFit) return;
    fitToPoints(map, initialPoints);
    setDidInitialFit(true);
  }, [map, initialPoints, didInitialFit]);
  useEffect(() => {
    if (!map || !didInitialFit) return;
    fitToPoints(map, points);
    // Refit only when the user changes filters, not on every points identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, filterKey]);
  return null;
}

export default function RestaurantsMap({ restaurants, apiKey }: Props) {
  const allPoints = useMemo(
    () =>
      restaurants.filter(
        (r): r is Geolocated => r.lat !== null && r.lng !== null,
      ),
    [restaurants],
  );
  const cities = useMemo(() => {
    const set = new Set(allPoints.map((p) => p.city));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allPoints]);
  const cuisines = useMemo(() => {
    const set = new Set(allPoints.flatMap((p) => p.cuisines));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allPoints]);
  const [cityFilter, setCityFilter] = useState<string>("");
  const [cuisineFilter, setCuisineFilter] = useState<string>("");
  const [minRating, setMinRating] = useState<string>("");
  const points = useMemo(() => {
    let filtered = allPoints;
    if (cityFilter) filtered = filtered.filter((p) => p.city === cityFilter);
    if (cuisineFilter) filtered = filtered.filter((p) => p.cuisines.includes(cuisineFilter));
    if (minRating) filtered = filtered.filter((p) => p.overall >= parseFloat(minRating));
    return filtered;
  }, [allPoints, cityFilter, cuisineFilter, minRating]);
  const sfPoints = useMemo(
    () => allPoints.filter((p) => p.city === "San Francisco"),
    [allPoints],
  );
  const initialFitPoints = sfPoints.length > 0 ? sfPoints : allPoints;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = points.find((p) => p.id === selectedId) ?? null;

  if (allPoints.length === 0) {
    return (
      <div className="rounded-md border border-stone-200 dark:border-stone-700 p-8 text-center text-sm text-stone-500">
        No restaurants have coordinates yet. Run{" "}
        <code className="font-mono">npm run db:backfill-geo</code> to populate.
      </div>
    );
  }

  // Initial center is the first available point; FitBounds widens it on mount.
  const initialCenter = { lat: allPoints[0].lat, lng: allPoints[0].lng };

  return (
    <APIProvider apiKey={apiKey}>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor="city-filter" className="text-stone-500">City:</label>
          <select
            id="city-filter"
            value={cityFilter}
            onChange={(e) => { setCityFilter(e.target.value); setSelectedId(null); }}
            className="px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
          >
            <option value="">All</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="cuisine-filter" className="text-stone-500">Cuisine:</label>
          <select
            id="cuisine-filter"
            value={cuisineFilter}
            onChange={(e) => { setCuisineFilter(e.target.value); setSelectedId(null); }}
            className="px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
          >
            <option value="">All</option>
            {cuisines.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="rating-filter" className="text-stone-500">Min rating:</label>
          <select
            id="rating-filter"
            value={minRating}
            onChange={(e) => { setMinRating(e.target.value); setSelectedId(null); }}
            className="px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
          >
            <option value="">Any</option>
            {[5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>{n}+</option>
            ))}
          </select>
        </div>
        <span className="text-stone-400">
          {points.length} of {allPoints.length} shown
        </span>
      </div>
      <div className="h-[70vh] w-full rounded-md overflow-hidden border border-stone-200 dark:border-stone-700">
        <Map
          mapId="restaurants-map"
          defaultCenter={initialCenter}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <FitBounds
            points={points}
            initialPoints={initialFitPoints}
            filterKey={`${cityFilter}|${cuisineFilter}|${minRating}`}
          />
          {points.map((r) => (
            <AdvancedMarker
              key={r.id}
              position={{ lat: r.lat, lng: r.lng }}
              onClick={() => setSelectedId(r.id)}
              title={r.name}
            >
              <div
                className="rounded-full border-2 border-white shadow-md flex items-center justify-center text-[10px] font-semibold text-white tabular-nums"
                style={{
                  width: 28,
                  height: 28,
                  backgroundColor: pinColor(r.overall),
                }}
              >
                {r.overall.toFixed(1)}
              </div>
            </AdvancedMarker>
          ))}
          {selected && (
            <InfoWindow
              position={{ lat: selected.lat, lng: selected.lng }}
              onCloseClick={() => setSelectedId(null)}
              pixelOffset={[0, -32]}
            >
              <div className="text-stone-900 w-[260px] pt-3">
                <div className="flex items-start gap-2 pr-6">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm leading-tight truncate">
                      {selected.name}
                    </div>
                    <div className="text-[11px] text-stone-500 mt-0.5 truncate">
                      {selected.cuisines.join(", ")} · {selected.city}
                    </div>
                  </div>
                  <div
                    className="shrink-0 rounded-full border-2 border-white shadow flex items-center justify-center text-xs font-bold text-white tabular-nums"
                    style={{
                      width: 36,
                      height: 36,
                      backgroundColor: pinColor(selected.overall),
                    }}
                    title={`Overall ${fmt(selected.overall, 2)}`}
                  >
                    {selected.overall.toFixed(1)}
                  </div>
                </div>
                {(() => {
                  const subs: { label: string; value: number }[] = [];
                  if (selected.food !== null) subs.push({ label: "Food", value: selected.food });
                  if (selected.value !== null) subs.push({ label: "Value", value: selected.value });
                  if (selected.service !== null) subs.push({ label: "Service", value: selected.service });
                  if (selected.ambiance !== null) subs.push({ label: "Vibe", value: selected.ambiance });
                  if (subs.length === 0) return null;
                  return (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {subs.map((s) => (
                        <span
                          key={s.label}
                          className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-700 tabular-nums"
                        >
                          {s.label} <span className="font-semibold">{s.value.toFixed(1)}</span>
                        </span>
                      ))}
                    </div>
                  );
                })()}
                {selected.note && (
                  <div className="mt-2 text-[11px] italic text-stone-600 line-clamp-2">
                    &ldquo;{selected.note}&rdquo;
                  </div>
                )}
                {selected.last_visited && (
                  <div className="mt-1.5 text-[10px] uppercase tracking-wide text-stone-400">
                    Last visited{" "}
                    {new Date(selected.last_visited).toLocaleDateString("en-US", {
                      month: "short",
                      year: "numeric",
                    })}
                    {selected.visit_count > 1 && ` · ${selected.visit_count} visits`}
                  </div>
                )}
                <div className="mt-2.5 flex gap-1.5">
                  <Link
                    href={`/restaurant/${selected.id}`}
                    className="flex-1 text-center rounded-md bg-stone-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-stone-700 transition-colors"
                  >
                    View details
                  </Link>
                  <a
                    href={
                      selected.place_id
                        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selected.name)}&query_place_id=${selected.place_id}`
                        : `https://www.google.com/maps/search/?api=1&query=${selected.lat},${selected.lng}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open in Google Maps"
                    title="Open in Google Maps"
                    className="inline-flex items-center justify-center rounded-md bg-stone-100 px-2.5 py-1.5 text-[11px] font-semibold text-stone-700 hover:bg-stone-200 transition-colors"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 mr-1" aria-hidden="true">
                      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
                    </svg>
                    Maps
                  </a>
                </div>
              </div>
            </InfoWindow>
          )}
        </Map>
      </div>
    </APIProvider>
  );
}
