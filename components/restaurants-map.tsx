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

function FitBounds({ points }: { points: Geolocated[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 64);
  }, [map, points]);
  return null;
}

export default function RestaurantsMap({ restaurants, apiKey }: Props) {
  const points = useMemo(
    () =>
      restaurants.filter(
        (r): r is Geolocated => r.lat !== null && r.lng !== null,
      ),
    [restaurants],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = points.find((p) => p.id === selectedId) ?? null;

  if (points.length === 0) {
    return (
      <div className="rounded-md border border-stone-200 dark:border-stone-700 p-8 text-center text-sm text-stone-500">
        No restaurants have coordinates yet. Run{" "}
        <code className="font-mono">npm run db:backfill-geo</code> to populate.
      </div>
    );
  }

  // Initial center is the first point; FitBounds widens it once the map mounts.
  const initialCenter = { lat: points[0].lat, lng: points[0].lng };

  return (
    <APIProvider apiKey={apiKey}>
      <div className="h-[70vh] w-full rounded-md overflow-hidden border border-stone-200 dark:border-stone-700">
        <Map
          mapId="restaurants-map"
          defaultCenter={initialCenter}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <FitBounds points={points} />
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
              <div className="text-stone-900 min-w-[180px]">
                <div className="font-semibold text-sm">{selected.name}</div>
                <div className="text-xs text-stone-600">
                  {selected.cuisine} · {selected.city}
                </div>
                <div className={`text-sm mt-1 ${ratingColorClass(selected.overall)}`}>
                  Overall {fmt(selected.overall, 2)}
                </div>
                <Link
                  href={`/restaurant/${selected.id}`}
                  className="text-xs text-blue-600 hover:underline mt-1 inline-block"
                >
                  Details →
                </Link>
              </div>
            </InfoWindow>
          )}
        </Map>
      </div>
    </APIProvider>
  );
}
