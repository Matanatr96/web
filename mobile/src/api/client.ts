import type { Diner, ParsedReceipt } from "@web-lib/receipts";
import type { PlacesSuggestionItem } from "./supabase";

export const DEFAULT_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://www.thelastmattapalli.com";

export type AutocompletePlacePick = {
  placeId: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  googleType?: string;
  googleTypeRaw?: string;
  matchedCuisine: string | null;
};

export type PhotoUploadItem = {
  data: string;
  media_type?: string;
};

export type CreateOrUpdateRestaurantInput = {
  id?: number | null;
  name: string;
  city: string;
  category?: "Food" | "Drink" | "Dessert" | string;
  cuisines: string[];
  unrated?: boolean;
  food?: number | null;
  value?: number | null;
  service?: number | null;
  ambiance?: number | null;
  vegan_options?: number | null;
  overall?: number | null;
  note?: string | null;
  last_visited?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  place_id?: string | null;
  existing_photos?: string[];
  deleted_photos?: string[];
  photos_base64?: (string | PhotoUploadItem)[];
  attach_receipt_id?: number | null;
};

export type LogVisitInput = {
  restaurant_id: number;
  visited_on?: string | null;
  comment?: string | null;
  food?: number | null;
  value?: number | null;
  service?: number | null;
  ambiance?: number | null;
  vegan_options?: number | null;
  attach_receipt_id?: number | null;
};

export type SaveReceiptInput = {
  restaurant_id: number | null;
  visited_on: string | null;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  parse_model: string | null;
  parsed_merchant: string | null;
  items: {
    name: string;
    price: number;
    qty: number;
    diner_ids: number[];
  }[];
};

let _adminToken: string | null = null;

/**
 * Configure the in-memory admin session token attached to outgoing `apiFetch`
 * requests (`Authorization: Bearer <token>` and `Cookie: admin_session=<token>`).
 *
 * @param token - SHA-256 session token (or null when signed out).
 */
export function setApiAdminToken(token: string | null): void {
  _adminToken = token;
}

/**
 * Retrieve the currently active admin session token.
 *
 * @returns Active token string or null.
 */
export function getApiAdminToken(): string | null {
  return _adminToken;
}

/**
 * Execute an authenticated JSON HTTP request against the Next.js backend
 * (`https://www.thelastmattapalli.com/api/*`). Automatically attaches both
 * `Authorization: Bearer <token>` and `Cookie: admin_session=<token>` headers
 * when an admin token is present in Keychain.
 *
 * @param path - Relative API path starting with `/api/...` or full URL.
 * @param init - Standard `RequestInit` options.
 * @returns Parsed JSON response of type `T`.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `${DEFAULT_API_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  if (_adminToken) {
    headers["Authorization"] = `Bearer ${_adminToken}`;
    headers["Cookie"] = `admin_session=${_adminToken}`;
  }

  const resp = await fetch(url, {
    ...init,
    headers,
  });

  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!resp.ok) {
    const errMsg =
      (json && typeof json === "object" && "error" in json && typeof (json as { error: unknown }).error === "string"
        ? (json as { error: string }).error
        : null) ?? `HTTP ${resp.status}: ${text || resp.statusText}`;
    throw new Error(errMsg);
  }

  return json as T;
}

/**
 * Verify an admin password or token against `POST /api/admin/verify` and
 * retrieve the canonical SHA-256 session token.
 *
 * @param passwordOrToken - Raw `ADMIN_PASSWORD` or SHA-256 token string.
 * @returns `{ authenticated: boolean; token: string | null }`.
 */
export async function verifyAdminCredentials(
  passwordOrToken: string,
): Promise<{ authenticated: boolean; token: string | null }> {
  return apiFetch<{ authenticated: boolean; token: string | null }>("/api/admin/verify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${passwordOrToken.trim()}`,
    },
    body: JSON.stringify({ password: passwordOrToken.trim() }),
  });
}

/**
 * Query `POST /api/restaurants/places-autocomplete` for Google Places predictions
 * with pre-extracted `city` and `matchedCuisine`.
 *
 * @param params - Search query and optional GPS location bias coordinates.
 * @returns Array of `AutocompletePlacePick` items.
 */
export async function autocompletePlaces(params: {
  query: string;
  lat?: number;
  lng?: number;
}): Promise<AutocompletePlacePick[]> {
  const res = await apiFetch<{ results: AutocompletePlacePick[] }>(
    "/api/restaurants/places-autocomplete",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
  return res.results ?? [];
}

/**
 * Query `POST /api/restaurants/places-suggest` for Bayesian-ranked untried
 * vegan-friendly Google Places in a given `(city, cuisine, category)`.
 *
 * @param params - `{ city, cuisine, category }`.
 * @returns `{ results: PlacesSuggestionItem[]; cached: boolean }`.
 */
export async function suggestUntriedPlaces(params: {
  city: string;
  cuisine: string;
  category: string;
}): Promise<{ results: PlacesSuggestionItem[]; cached: boolean }> {
  return apiFetch<{ results: PlacesSuggestionItem[]; cached: boolean }>(
    "/api/restaurants/places-suggest",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

/**
 * Create or update a restaurant (either rated with an initial `restaurant_visits`
 * entry, or an unrated `Want to Go` bookmark) via `POST /api/admin/restaurants`.
 *
 * @param payload - `CreateOrUpdateRestaurantInput`.
 * @returns Created/updated restaurant ID and metadata for the Google Review prompt.
 */
export async function saveRestaurantMutation(
  payload: CreateOrUpdateRestaurantInput,
): Promise<{
  ok: boolean;
  restaurant_id: number;
  placeId: string | null;
  note: string | null;
  name: string;
}> {
  return apiFetch("/api/admin/restaurants", {
    method: "POST",
    body: JSON.stringify({
      action: "create_or_update_restaurant",
      ...payload,
    }),
  });
}

/**
 * Delete a restaurant and its stored photos via `POST /api/admin/restaurants`.
 *
 * @param id - Restaurant ID to delete.
 * @returns `{ ok: boolean; deleted: number }`.
 */
export async function deleteRestaurantMutation(
  id: number,
): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch("/api/admin/restaurants", {
    method: "POST",
    body: JSON.stringify({
      action: "delete_restaurant",
      id,
    }),
  });
}

/**
 * Log a new visit to an existing restaurant and recompute its exponential-decay
 * weighted ratings via `POST /api/admin/restaurants`.
 *
 * @param payload - `LogVisitInput` including `restaurant_id`, ratings, comment, and optional `attach_receipt_id`.
 * @returns `{ ok: boolean; restaurant_id: number }`.
 */
export async function logVisitMutation(
  payload: LogVisitInput,
): Promise<{ ok: boolean; restaurant_id: number }> {
  return apiFetch("/api/admin/restaurants", {
    method: "POST",
    body: JSON.stringify({
      action: "log_visit",
      ...payload,
    }),
  });
}

/**
 * Delete a single visit log entry and recompute the parent restaurant's
 * weighted ratings via `POST /api/admin/restaurants`.
 *
 * @param visitId - Visit primary key to delete.
 * @param restaurantId - Parent restaurant primary key.
 * @returns `{ ok: boolean; deleted: number; restaurant_id: number }`.
 */
export async function deleteVisitMutation(
  visitId: number,
  restaurantId: number,
): Promise<{ ok: boolean; deleted: number; restaurant_id: number }> {
  return apiFetch("/api/admin/restaurants", {
    method: "POST",
    body: JSON.stringify({
      action: "delete_visit",
      visit_id: visitId,
      restaurant_id: restaurantId,
    }),
  });
}

/**
 * Add a new canonical cuisine via `POST /api/admin/restaurants`.
 *
 * @param name - New cuisine name.
 * @returns `{ ok: boolean; name: string }`.
 */
export async function addCuisineMutation(
  name: string,
): Promise<{ ok: boolean; name: string }> {
  return apiFetch("/api/admin/restaurants", {
    method: "POST",
    body: JSON.stringify({
      action: "add_cuisine",
      name,
    }),
  });
}

/**
 * Parse a base64-encoded receipt photo using Claude Haiku 4.5 (with Opus 4.7
 * fallback) via `POST /api/receipts/parse`.
 *
 * @param imageBase64 - Base64 JPEG data string.
 * @param mediaType - Image MIME type (defaults to `"image/jpeg"`).
 * @returns `{ parsed: ParsedReceipt; model: string }`.
 */
export async function parseReceiptImage(
  imageBase64: string,
  mediaType: string = "image/jpeg",
): Promise<{ parsed: ParsedReceipt; model: string }> {
  return apiFetch<{ parsed: ParsedReceipt; model: string }>("/api/receipts/parse", {
    method: "POST",
    body: JSON.stringify({
      image_base64: imageBase64,
      media_type: mediaType,
    }),
  });
}

/**
 * Persist an itemized receipt split to Supabase via `POST /api/receipts`.
 *
 * @param payload - `SaveReceiptInput`.
 * @returns `{ id: number }` with the saved receipt ID for universal-link sharing.
 */
export async function saveReceiptSplit(
  payload: SaveReceiptInput,
): Promise<{ id: number }> {
  return apiFetch<{ id: number }>("/api/receipts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Link an existing saved receipt to a Google Place via `POST /api/receipts/link`
 * (creating a placeholder restaurant row if one does not yet exist for `placeId`).
 *
 * @param receiptId - Saved receipt ID.
 * @param place - Google Place pick metadata.
 * @returns `{ restaurant_id: number; is_new: boolean; is_rated: boolean }`.
 */
export async function linkReceiptToPlace(
  receiptId: number,
  place: {
    placeId: string;
    name: string;
    address: string;
    city: string;
    lat: number;
    lng: number;
    googleType?: string;
    googleTypeRaw?: string;
  },
): Promise<{ restaurant_id: number; is_new: boolean; is_rated: boolean }> {
  return apiFetch<{ restaurant_id: number; is_new: boolean; is_rated: boolean }>(
    "/api/receipts/link",
    {
      method: "POST",
      body: JSON.stringify({
        receipt_id: receiptId,
        place,
      }),
    },
  );
}

/**
 * Create a new diner or rename an existing diner via `POST /api/diners`.
 *
 * @param params - `{ id?: number; name: string }`.
 * @returns `{ diner: Diner }`.
 */
export async function upsertDiner(params: {
  id?: number;
  name: string;
}): Promise<{ diner: Diner }> {
  return apiFetch<{ diner: Diner }>("/api/diners", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Delete a non-self diner via `DELETE /api/diners`.
 *
 * @param id - Diner ID to delete.
 * @returns `{ deleted: number }`.
 */
export async function deleteDiner(id: number): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>("/api/diners", {
    method: "DELETE",
    body: JSON.stringify({ id }),
  });
}
