"use client";

import { useEffect, useRef, useState } from "react";
import { APIProvider, useMapsLibrary } from "@vis.gl/react-google-maps";

export type PlacePick = {
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  placeId: string;
  /** Human-readable primary type from the Places API, e.g. "Sushi Restaurant". */
  googleType?: string;
  /** Raw primary type enum, e.g. "sushi_restaurant". */
  googleTypeRaw?: string;
};

type Props = {
  apiKey: string;
  initialName?: string;
  inputName: string;
  required?: boolean;
  onPick: (pick: PlacePick) => void;
  onTextChange?: (value: string) => void;
};

/**
 * Wraps Google's PlaceAutocompleteElement (Places API New). The element is a
 * web component that renders its own input; we mount it into a div and forward
 * the selected place via onPick. A hidden input named `inputName` carries the
 * current place name so the surrounding <form> can submit it as a normal field.
 */
export default function PlaceAutocomplete(props: Props) {
  return (
    <APIProvider apiKey={props.apiKey} libraries={["places"]}>
      <AutocompleteInner {...props} />
    </APIProvider>
  );
}

function AutocompleteInner({
  initialName,
  inputName,
  required,
  onPick,
  onTextChange,
}: Omit<Props, "apiKey">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const places = useMapsLibrary("places");
  const [name, setName] = useState(initialName ?? "");

  // Keep latest callbacks in refs so we don't have to re-init the element when
  // the parent re-renders with new function identities.
  const onPickRef = useRef(onPick);
  const onTextChangeRef = useRef(onTextChange);
  useEffect(() => {
    onPickRef.current = onPick;
    onTextChangeRef.current = onTextChange;
  });

  useEffect(() => {
    if (!places || !containerRef.current) return;

    // PlaceAutocompleteElement is part of Places API (New). Types may not be
    // present on older @types/google.maps; cast through unknown.
    const PAE = (places as unknown as {
      PlaceAutocompleteElement: new () => HTMLElement;
    }).PlaceAutocompleteElement;
    const element = new PAE();
    containerRef.current.replaceChildren(element);

    const handleSelect = async (event: Event) => {
      const placePrediction = (event as unknown as {
        placePrediction?: {
          toPlace: () => {
            fetchFields: (opts: { fields: string[] }) => Promise<void>;
            id?: string;
            displayName?: string;
            formattedAddress?: string;
            location?: { lat: () => number; lng: () => number };
            addressComponents?: Array<{ longText: string; types: string[] }>;
          };
        };
      }).placePrediction;
      if (!placePrediction) return;
      const place = placePrediction.toPlace();
      await place.fetchFields({
        fields: [
          "id",
          "displayName",
          "formattedAddress",
          "location",
          "addressComponents",
          "primaryTypeDisplayName",
          "primaryType",
        ],
      });
      const components = place.addressComponents ?? [];
      const cityComp =
        components.find((c) => c.types.includes("locality")) ??
        components.find((c) => c.types.includes("postal_town")) ??
        components.find((c) => c.types.includes("sublocality")) ??
        components.find((c) => c.types.includes("administrative_area_level_2"));
      const pickedName = place.displayName ?? "";
      const p = place as unknown as { primaryTypeDisplayName?: { text: string }; primaryType?: string };
      const googleType = p.primaryTypeDisplayName?.text;
      const googleTypeRaw = p.primaryType;
      setName(pickedName);
      onTextChangeRef.current?.(pickedName);
      onPickRef.current({
        name: pickedName,
        address: place.formattedAddress ?? "",
        city: cityComp?.longText ?? "",
        lat: place.location?.lat() ?? 0,
        lng: place.location?.lng() ?? 0,
        placeId: place.id ?? "",
        googleType,
        googleTypeRaw,
      });
    };

    element.addEventListener("gmp-select", handleSelect);
    return () => {
      element.removeEventListener("gmp-select", handleSelect);
    };
  }, [places]);

  return (
    <div>
      <div ref={containerRef} className="w-full" />
      <input type="hidden" name={inputName} value={name} required={required} />
      {initialName && name === initialName && (
        <p className="text-xs text-stone-500 mt-1">
          Current: <span className="font-medium">{initialName}</span> — pick a
          new place to change.
        </p>
      )}
    </div>
  );
}
