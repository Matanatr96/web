import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Location from "expo-location";
import type { Restaurant } from "@web-lib/types";
import { CUISINES, RATING_WEIGHTS, computeOverall, fmt } from "@web-lib/utils";
import { isRatedRestaurant, matchCuisineFromGoogleType } from "@web-lib/restaurants-query";
import { useRestaurants, type AddRateSheetParams } from "@/store/RestaurantsContext";
import { useAuth } from "@/auth/AuthContext";
import {
  addCuisineMutation,
  autocompletePlaces,
  logVisitMutation,
  saveRestaurantMutation,
  type AutocompletePlacePick,
  type CreateOrUpdateRestaurantInput,
} from "@/api/client";
import type { MobileReceiptRow } from "@/api/supabase";
import { WANT_TO_GO_HEX, cx, formatVisitDate, ratingHex } from "@/components/RestaurantDetailSheet";

/**
 * Optional intent carried alongside `AddRateSheetParams` (the context stores
 * params verbatim, so callers can pass `{ restaurantId, intent: "edit" }`).
 * `"log"` (default for rated restaurants) logs a new visit; `"edit"` edits
 * name/city/category/cuisines/note/photos without touching ratings.
 */
export type AddRateIntent = "log" | "edit";

/** `AddRateSheetParams` plus the optional `intent` understood by this sheet. */
export type AddRateSheetIntentParams = AddRateSheetParams & { intent?: AddRateIntent };

export type AddRateVisitSheetProps = {
  visible?: boolean;
  params?: AddRateSheetIntentParams | null;
  onClose?: () => void;
};

type RatingKey = "food" | "vegan_options" | "ambiance" | "value" | "service";
type Ratings = Record<RatingKey, number | null>;
type EntryMode = "rate" | "want_to_go";
type Mode = "search" | "create" | "rate_saved" | "log_visit" | "edit";
type Target =
  | { kind: "none" }
  | { kind: "new"; place: AutocompletePlacePick | null }
  | { kind: "existing"; restaurant: Restaurant; intent: AddRateIntent };
type LocalPhoto = { uri: string; data: string; media_type: string };
type PanState = { dx: number; dy: number };

const EMPTY_RATINGS: Ratings = {
  food: null,
  vegan_options: null,
  ambiance: null,
  value: null,
  service: null,
};

/** Ordered by weight in `RATING_WEIGHTS` (food ≈ 90% of `overall`). */
const RATING_FIELDS: { key: RatingKey; label: string; hint: string }[] = [
  { key: "food", label: "Food", hint: "How good was the food?" },
  { key: "vegan_options", label: "Vegan Options", hint: "Breadth & quality of vegan dishes" },
  { key: "ambiance", label: "Ambiance", hint: "Vibe, decor, noise" },
  { key: "value", label: "Value for Money", hint: "Worth the price?" },
  { key: "service", label: "Service", hint: "Speed & friendliness" },
];

const CATEGORIES = ["Food", "Drink", "Dessert"] as const;
const ANCHORS = [6, 7, 8, 9, 10] as const;
const MAX_PHOTOS = 5;
const COLLAPSED_CUISINE_COUNT = 14;
const SHEET_HANDOFF_DELAY_MS = 380;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localIsoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()) / 86400000,
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

/**
 * Heuristic relevance of an unlinked receipt to the visit being logged:
 * same date (+3), within 3 days (+1), merchant/name token overlap (+4).
 */
function scoreReceipt(rc: MobileReceiptRow, visitedOn: string, name: string): number {
  const date = rc.visited_on ?? rc.created_at.slice(0, 10);
  let s = 0;
  if (date === visitedOn) s += 3;
  else if (daysBetween(date, visitedOn) <= 3) s += 1;
  if (rc.parsed_merchant && name.trim()) {
    const a = tokens(rc.parsed_merchant);
    for (const t of tokens(name)) {
      if (a.has(t)) {
        s += 4;
        break;
      }
    }
  }
  return s;
}

function haptic(kind: "select" | "light" | "medium" | "success" | "error"): void {
  const p =
    kind === "select"
      ? Haptics.selectionAsync()
      : kind === "light"
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        : kind === "medium"
          ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
          : Haptics.notificationAsync(
              kind === "success"
                ? Haptics.NotificationFeedbackType.Success
                : Haptics.NotificationFeedbackType.Error,
            );
  p.catch(() => {});
}

function promptGoogleReview(data: { placeId: string; note: string | null; name: string }): void {
  Alert.alert(
    "Leave a Google Review?",
    data.note
      ? "Your note will be copied to the clipboard — paste it into Google."
      : `Share your experience at ${data.name} on Google.`,
    [
      { text: "Maybe later", style: "cancel" },
      {
        text: "Leave Review ↗",
        onPress: async () => {
          if (data.note) await Clipboard.setStringAsync(data.note).catch(() => false);
          await Linking.openURL(
            `https://search.google.com/local/writereview?placeid=${data.placeId}`,
          ).catch(() => {});
        },
      },
    ],
  );
}

/**
 * Global Sheet A — the 15-second Add / Rate / Log Visit flow.
 *
 * 1. Google Places search (`/api/restaurants/places-autocomplete`, GPS-biased)
 *    with instant local matches; picking a place already in `restaurants`
 *    (same `place_id`) auto-switches to "Log Visit #N+1" (or "Rate Saved Place"
 *    for an unrated bookmark) instead of erroring.
 * 2. Auto-filled metadata (city, address, coords, `matchCuisineFromGoogleType`
 *    cuisine pinned first) with a `Food | Drink | Dessert` segmented control.
 * 3. `⭐ Rate / Log Visit` vs `🔖 Want to Go` toggle.
 * 4. Live `computeOverall` header + 5 haptic slider cards (0–10, step 0.1,
 *    6–10 anchors, ±0.1 nudges), visit date, note/comment, photos, and a 1-tap
 *    "attach unlinked receipt" pill.
 * 5. Saves via `/api/admin/restaurants` (`create_or_update_restaurant` /
 *    `log_visit`), refreshes the cache, and offers the Google Review prompt.
 *
 * @param props - Optional overrides; defaults read `useRestaurants().addRateSheetState`.
 * @returns The modal sheet, or null when hidden.
 */
export default function AddRateVisitSheet(props: AddRateVisitSheetProps) {
  const {
    addRateSheetState,
    closeAddRateSheet,
    restaurants,
    cuisines: cuisineRows,
    recentReceipts,
    refreshAll,
    fetchDetail,
  } = useRestaurants();
  const { isAdmin, openAuthModal } = useAuth();

  const visible = props.visible ?? addRateSheetState.open;
  const params = (props.params ?? addRateSheetState.params) as AddRateSheetIntentParams | null;
  const handleClose = props.onClose ?? closeAddRateSheet;

  // ── State ───────────────────────────────────────────────────────────────
  const [target, setTarget] = useState<Target>({ kind: "none" });
  const [entryMode, setEntryMode] = useState<EntryMode>("rate");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AutocompletePlacePick[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);

  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [googleType, setGoogleType] = useState<string | null>(null);
  const [suggestedCuisine, setSuggestedCuisine] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("Food");
  const [selectedCuisines, setSelectedCuisines] = useState<string[]>([]);
  const [cuisineFilter, setCuisineFilter] = useState("");
  const [showAllCuisines, setShowAllCuisines] = useState(false);
  const [addingCuisine, setAddingCuisine] = useState(false);

  const [ratings, setRatings] = useState<Ratings>(EMPTY_RATINGS);
  const [priorRatings, setPriorRatings] = useState<Ratings | null>(null);
  const [visitedOn, setVisitedOn] = useState(localIsoDate());
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [attachReceiptId, setAttachReceiptId] = useState<number | null>(null);
  const [showReceiptList, setShowReceiptList] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const today = localIsoDate();
  const cuisineNames = useMemo(
    () => (cuisineRows.length > 0 ? cuisineRows.map((c) => c.name) : CUISINES),
    [cuisineRows],
  );

  // ── Field population helpers ────────────────────────────────────────────
  const selectExisting = useCallback(
    (r: Restaurant, intent: AddRateIntent) => {
      setTarget({ kind: "existing", restaurant: r, intent });
      setName(r.name);
      setCity(r.city);
      setAddress(r.address);
      setCoords(r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null);
      setPlaceId(r.place_id);
      setCategory(r.category || "Food");
      setSelectedCuisines(r.cuisines);
      setNote(intent === "edit" || !isRatedRestaurant(r) ? (r.note ?? "") : "");
      setSaveError(null);
      if (isRatedRestaurant(r)) {
        const current: Ratings = {
          food: r.food,
          vegan_options: r.vegan_options,
          ambiance: r.ambiance,
          value: r.value,
          service: r.service,
        };
        // Mirror LogVisitModal: pre-fill with current weighted averages.
        setRatings(current);
        setPriorRatings(current);
        setEntryMode("rate");
      } else {
        setRatings(EMPTY_RATINGS);
        setPriorRatings(null);
      }
      haptic("light");
    },
    [],
  );

  const applyPlace = useCallback(
    (pick: AutocompletePlacePick) => {
      const existing = restaurants.find((r) => r.place_id && r.place_id === pick.placeId);
      if (existing) {
        selectExisting(existing, "log");
        return;
      }
      const matched =
        pick.matchedCuisine ??
        matchCuisineFromGoogleType(pick.googleType, pick.googleTypeRaw, cuisineNames);
      setTarget({ kind: "new", place: pick });
      setName(pick.name);
      setCity(pick.city || "");
      setAddress(pick.address || null);
      setCoords(Number.isFinite(pick.lat) && Number.isFinite(pick.lng) ? { lat: pick.lat, lng: pick.lng } : null);
      setPlaceId(pick.placeId || null);
      setGoogleType(pick.googleType ?? null);
      setSuggestedCuisine(matched);
      setSelectedCuisines(matched ? [matched] : []);
      setCategory("Food");
      setRatings(EMPTY_RATINGS);
      setPriorRatings(null);
      setSaveError(null);
      haptic("light");
    },
    [restaurants, cuisineNames, selectExisting],
  );

  const startManual = useCallback(() => {
    setTarget({ kind: "new", place: null });
    setName(query.trim());
    setCity("");
    setAddress(null);
    setCoords(null);
    setPlaceId(null);
    setGoogleType(null);
    setSuggestedCuisine(null);
    setSelectedCuisines([]);
    setRatings(EMPTY_RATINGS);
    setPriorRatings(null);
    haptic("light");
  }, [query]);

  const backToSearch = useCallback(() => {
    setTarget({ kind: "none" });
    setSaveError(null);
  }, []);

  // ── Reset on open ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const p = params ?? {};
    setTarget({ kind: "none" });
    setEntryMode(p.initialMode ?? "rate");
    setResults([]);
    setSearchError(null);
    setName("");
    setCity("");
    setAddress(null);
    setCoords(null);
    setPlaceId(null);
    setGoogleType(null);
    setSuggestedCuisine(null);
    setCategory("Food");
    setSelectedCuisines([]);
    setCuisineFilter("");
    setShowAllCuisines(false);
    setRatings(EMPTY_RATINGS);
    setPriorRatings(null);
    setVisitedOn(p.visitedOn && ISO_DATE_RE.test(p.visitedOn) ? p.visitedOn : localIsoDate());
    setNote("");
    setPhotos([]);
    setAttachReceiptId(p.attachReceiptId ?? null);
    setShowReceiptList(false);
    setSaving(false);
    setSaveError(null);

    const handedReceipt =
      p.attachReceiptId !== undefined
        ? recentReceipts.find((rc) => rc.id === p.attachReceiptId)
        : undefined;
    setQuery(handedReceipt?.parsed_merchant ?? "");

    if (p.restaurantId !== undefined) {
      const r = restaurants.find((x) => x.id === p.restaurantId);
      if (r) selectExisting(r, p.intent ?? "log");
      else setSaveError(`Restaurant #${p.restaurantId} isn't in the local cache yet — pull to refresh.`);
    } else if (p.initialPlace) {
      applyPlace(p.initialPlace);
    }

    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted || cancelled) return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!cancelled) setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch {
        // Location bias is best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-initialize only when the sheet opens with a new params object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, params]);

  const mode: Mode =
    target.kind === "none"
      ? "search"
      : target.kind === "new"
        ? "create"
        : target.intent === "edit"
          ? "edit"
          : isRatedRestaurant(target.restaurant)
            ? "log_visit"
            : "rate_saved";
  const existing = target.kind === "existing" ? target.restaurant : null;

  // ── Places search (debounced) ───────────────────────────────────────────
  useEffect(() => {
    if (!visible || mode !== "search" || !isAdmin) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const t = setTimeout(async () => {
      try {
        const res = await autocompletePlaces({ query: q, lat: gps?.lat, lng: gps?.lng });
        if (!cancelled) setResults(res);
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error ? e.message : "Places search failed.");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [visible, mode, isAdmin, query, gps]);

  const localMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return restaurants.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 5);
  }, [restaurants, query]);

  // ── Derived values ──────────────────────────────────────────────────────
  const showRatings =
    mode === "log_visit" ||
    ((mode === "create" || mode === "rate_saved") && entryMode === "rate");
  const showMetadata = mode === "create" || mode === "rate_saved" || mode === "edit";
  const weights = RATING_WEIGHTS[category] ?? RATING_WEIGHTS.Food;
  const computedOverall = computeOverall(category, ratings);

  const duplicateByName = useMemo(() => {
    if (mode !== "create") return null;
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return restaurants.find((r) => r.name.trim().toLowerCase() === n) ?? null;
  }, [mode, name, restaurants]);

  const receiptSuggestions = useMemo(() => {
    const unlinked = recentReceipts.filter(
      (rc) => rc.restaurant_id === null || rc.id === attachReceiptId,
    );
    return unlinked
      .map((rc) => ({ rc, score: scoreReceipt(rc, visitedOn, name) }))
      .sort((a, b) => b.score - a.score);
  }, [recentReceipts, attachReceiptId, visitedOn, name]);
  const topReceipt = receiptSuggestions.find((s) => s.score > 0)?.rc ?? null;
  const attachedReceipt =
    attachReceiptId !== null ? (recentReceipts.find((rc) => rc.id === attachReceiptId) ?? null) : null;

  const orderedCuisines = useMemo(() => {
    const f = cuisineFilter.trim().toLowerCase();
    const selected = new Set(selectedCuisines);
    const rest = cuisineNames.filter(
      (c) => !selected.has(c) && c !== suggestedCuisine && (!f || c.toLowerCase().includes(f)),
    );
    const head = [
      ...selectedCuisines,
      ...(suggestedCuisine && !selected.has(suggestedCuisine) ? [suggestedCuisine] : []),
    ];
    const all = [...head, ...rest];
    if (f || showAllCuisines) return all;
    return all.slice(0, Math.max(COLLAPSED_CUISINE_COUNT, head.length));
  }, [cuisineNames, selectedCuisines, suggestedCuisine, cuisineFilter, showAllCuisines]);

  const canAddTypedCuisine =
    cuisineFilter.trim().length > 1 &&
    !cuisineNames.some((c) => c.toLowerCase() === cuisineFilter.trim().toLowerCase());

  const validationError = useMemo((): string | null => {
    if (mode === "search") return null;
    if (!isAdmin) return "Unlock admin mode to save.";
    if (mode !== "log_visit") {
      if (!name.trim()) return "Name is required.";
      if (!city.trim()) return "City is required.";
      if (selectedCuisines.length === 0) return "Pick at least one cuisine.";
    }
    if (showRatings) {
      if (!ISO_DATE_RE.test(visitedOn)) return "Visit date must be YYYY-MM-DD.";
      if (visitedOn > today) return "Visit date can't be in the future.";
    }
    if ((mode === "create" || mode === "rate_saved") && entryMode === "rate") {
      const missing = RATING_FIELDS.filter((f) => ratings[f.key] === null).map((f) => f.label);
      if (missing.length > 0) return `Rate ${missing.join(", ")} to compute Overall.`;
    }
    return null;
  }, [mode, isAdmin, name, city, selectedCuisines, showRatings, visitedOn, today, entryMode, ratings]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const setRating = useCallback((key: RatingKey, v: number | null) => {
    setRatings((prev) => ({
      ...prev,
      [key]: v === null ? null : Math.max(0, Math.min(10, round1(v))),
    }));
  }, []);

  const toggleCuisine = useCallback((c: string) => {
    haptic("select");
    setSelectedCuisines((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }, []);

  const addTypedCuisine = useCallback(async () => {
    const n = cuisineFilter.trim();
    if (!n) return;
    setAddingCuisine(true);
    try {
      await addCuisineMutation(n);
      await refreshAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) {
        Alert.alert("Couldn't add cuisine", msg);
        setAddingCuisine(false);
        return;
      }
    }
    setSelectedCuisines((prev) => (prev.includes(n) ? prev : [...prev, n]));
    setCuisineFilter("");
    setAddingCuisine(false);
    haptic("success");
  }, [cuisineFilter, refreshAll]);

  const addPhotos = useCallback(
    async (source: "camera" | "library") => {
      const remaining = MAX_PHOTOS - photos.length;
      if (remaining <= 0) return;
      try {
        const perm =
          source === "camera"
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("Permission needed", `Allow ${source} access in Settings to add photos.`);
          return;
        }
        const res =
          source === "camera"
            ? await ImagePicker.launchCameraAsync({ mediaTypes: "images", quality: 1 })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: "images",
                allowsMultipleSelection: true,
                selectionLimit: remaining,
                quality: 1,
              });
        if (res.canceled || !res.assets) return;
        const processed: LocalPhoto[] = [];
        for (const a of res.assets.slice(0, remaining)) {
          const longest = Math.max(a.width, a.height);
          const actions: ImageManipulator.Action[] =
            longest > 1800
              ? [{ resize: a.width >= a.height ? { width: 1800 } : { height: 1800 } }]
              : [];
          const out = await ImageManipulator.manipulateAsync(a.uri, actions, {
            compress: 0.82,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          });
          if (out.base64) processed.push({ uri: out.uri, data: out.base64, media_type: "image/jpeg" });
        }
        setPhotos((prev) => [...prev, ...processed].slice(0, MAX_PHOTOS));
        haptic("light");
      } catch (e) {
        Alert.alert("Photo error", e instanceof Error ? e.message : String(e));
      }
    },
    [photos.length],
  );

  const unlockAdmin = useCallback(() => {
    handleClose();
    setTimeout(openAuthModal, SHEET_HANDOFF_DELAY_MS);
  }, [handleClose, openAuthModal]);

  const save = useCallback(async () => {
    if (validationError || saving) {
      if (validationError) haptic("error");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const photoPayload = photos.map((p) => ({ data: p.data, media_type: p.media_type }));
    const noteOrNull = note.trim() ? note.trim() : null;
    let restaurantId: number;
    let review: { placeId: string; note: string | null; name: string } | null = null;

    try {
      if (mode === "log_visit" && existing) {
        if (photoPayload.length > 0) {
          // Upload photos first while preserving the current aggregates; log_visit
          // then recomputes ratings from the full visit history.
          await saveRestaurantMutation({
            id: existing.id,
            name: existing.name,
            city: existing.city,
            category: existing.category,
            cuisines: existing.cuisines,
            food: existing.food,
            value: existing.value,
            service: existing.service,
            ambiance: existing.ambiance,
            vegan_options: existing.vegan_options,
            overall: existing.overall,
            note: existing.note,
            last_visited: existing.last_visited,
            address: existing.address,
            lat: existing.lat,
            lng: existing.lng,
            place_id: existing.place_id,
            existing_photos: existing.photos ?? [],
            photos_base64: photoPayload,
          });
        }
        await logVisitMutation({
          restaurant_id: existing.id,
          visited_on: visitedOn,
          comment: noteOrNull,
          food: ratings.food,
          value: ratings.value,
          service: ratings.service,
          ambiance: ratings.ambiance,
          vegan_options: ratings.vegan_options,
          attach_receipt_id: attachReceiptId,
        });
        restaurantId = existing.id;
      } else {
        const rateNow = (mode === "create" || mode === "rate_saved") && entryMode === "rate";
        const keepRated = mode === "edit" && existing !== null && isRatedRestaurant(existing);
        const payload: CreateOrUpdateRestaurantInput = {
          id: existing?.id ?? null,
          name: name.trim(),
          city: city.trim(),
          category,
          cuisines: selectedCuisines,
          note: noteOrNull,
          address,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          place_id: placeId,
          photos_base64: photoPayload.length > 0 ? photoPayload : undefined,
          existing_photos: existing ? (existing.photos ?? []) : undefined,
          attach_receipt_id: rateNow ? attachReceiptId : null,
        };
        if (rateNow) {
          Object.assign(payload, {
            unrated: false,
            ...ratings,
            overall: computedOverall,
            last_visited: visitedOn,
          });
        } else if (keepRated && existing) {
          // Edit details only: resend current aggregates so they are preserved.
          Object.assign(payload, {
            unrated: false,
            food: existing.food,
            value: existing.value,
            service: existing.service,
            ambiance: existing.ambiance,
            vegan_options: existing.vegan_options,
            overall: computeOverall(category, existing) ?? existing.overall,
            last_visited: existing.last_visited,
          });
        } else {
          Object.assign(payload, { unrated: true, last_visited: null });
        }
        const res = await saveRestaurantMutation(payload);
        restaurantId = res.restaurant_id;
        if (rateNow && res.placeId) {
          review = { placeId: res.placeId, note: res.note, name: res.name };
        }
      }

      haptic("success");
      handleClose();
      refreshAll()
        .then(() => fetchDetail(restaurantId, true))
        .catch(() => {});
      if (review) {
        const r = review;
        setTimeout(() => promptGoogleReview(r), SHEET_HANDOFF_DELAY_MS + 150);
      }
    } catch (e) {
      haptic("error");
      setSaveError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [
    validationError,
    saving,
    photos,
    note,
    mode,
    existing,
    visitedOn,
    ratings,
    attachReceiptId,
    entryMode,
    name,
    city,
    category,
    selectedCuisines,
    address,
    coords,
    placeId,
    computedOverall,
    handleClose,
    refreshAll,
    fetchDetail,
  ]);

  if (!visible) return null;

  const title =
    mode === "search"
      ? "Add / Rate Restaurant"
      : mode === "create"
        ? "New Restaurant"
        : mode === "rate_saved"
          ? "Rate Saved Place"
          : mode === "log_visit"
            ? `Log Visit #${(existing?.visit_count ?? 0) + 1}`
            : "Edit Details";

  const saveLabel =
    mode === "log_visit"
      ? `Log Visit #${(existing?.visit_count ?? 0) + 1}`
      : mode === "edit"
        ? "Save Changes"
        : entryMode === "want_to_go"
          ? mode === "rate_saved"
            ? "Update Bookmark 🔖"
            : "Save to Want to Go 🔖"
          : mode === "rate_saved"
            ? "Save First Rating ⭐"
            : "Save & Rate ⭐";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView behavior="padding" style={styles.container}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Pressable onPress={handleClose} hitSlop={10}>
            <Text style={styles.headerLink}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {mode !== "search" && (mode === "create" || target.kind === "existing") ? (
            <Pressable onPress={backToSearch} hitSlop={10}>
              <Text style={styles.headerLink}>Change</Text>
            </Pressable>
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </View>

        {!isAdmin ? (
          <View style={styles.lockBanner}>
            <Text style={styles.lockText}>🔒 Admin mode is locked — saving requires your admin password.</Text>
            <Pressable onPress={unlockAdmin} style={styles.lockBtn}>
              <Text style={styles.lockBtnText}>Unlock</Text>
            </Pressable>
          </View>
        ) : null}

        {mode === "search" ? (
          <View style={styles.flex1}>
            <View style={styles.searchWrap}>
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                autoFocus
                placeholder="Search Google Places…"
                placeholderTextColor="#78716c"
                returnKeyType="search"
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {searching ? <ActivityIndicator size="small" color="#10b981" /> : null}
            </View>
            <ScrollView
              style={styles.flex1}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.searchResults}
            >
              {localMatches.length > 0 ? (
                <>
                  <Text style={styles.sectionLabel}>Already in your list</Text>
                  {localMatches.map((r) => {
                    const rated = isRatedRestaurant(r);
                    return (
                      <Pressable
                        key={`local-${r.id}`}
                        onPress={() => selectExisting(r, "log")}
                        style={({ pressed }) => cx(styles.resultRow, pressed && styles.pressed)}
                      >
                        <View style={styles.flex1}>
                          <Text style={styles.resultName}>{r.name}</Text>
                          <Text style={styles.resultSub}>
                            {r.city} · {r.cuisines.join(", ") || r.category}
                          </Text>
                        </View>
                        <Text
                          style={[
                            styles.resultBadge,
                            { color: rated ? ratingHex(r.overall) : WANT_TO_GO_HEX },
                          ]}
                        >
                          {rated ? `${fmt(r.overall, 1)} · Log visit` : "🔖 Rate"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </>
              ) : null}

              {results.length > 0 ? <Text style={styles.sectionLabel}>Google Places</Text> : null}
              {results.map((p) => {
                const saved = restaurants.find((r) => r.place_id && r.place_id === p.placeId);
                return (
                  <Pressable
                    key={p.placeId}
                    onPress={() => applyPlace(p)}
                    style={({ pressed }) => cx(styles.resultRow, pressed && styles.pressed)}
                  >
                    <View style={styles.flex1}>
                      <Text style={styles.resultName}>{p.name}</Text>
                      <Text style={styles.resultSub} numberOfLines={1}>
                        {p.address}
                      </Text>
                    </View>
                    {saved ? (
                      <Text style={[styles.resultBadge, { color: "#10b981" }]}>Saved ✓</Text>
                    ) : p.matchedCuisine ? (
                      <Text style={styles.resultBadge}>{p.matchedCuisine}</Text>
                    ) : null}
                  </Pressable>
                );
              })}

              {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}

              {query.trim().length >= 2 && isAdmin ? (
                <Pressable onPress={startManual} style={styles.manualRow}>
                  <Text style={styles.manualText}>＋ Add “{query.trim()}” manually</Text>
                </Pressable>
              ) : null}

              {query.trim().length < 2 ? (
                <Text style={styles.searchHint}>
                  {gps ? "📍 Results biased to your current location." : "Type a restaurant name to search."}
                </Text>
              ) : null}
            </ScrollView>
          </View>
        ) : (
          <>
            {showRatings ? (
              <View style={styles.overallBar}>
                <View>
                  <Text style={styles.overline}>
                    {mode === "log_visit" ? "This visit" : "Overall"}
                  </Text>
                  <Text style={[styles.overallValue, { color: ratingHex(computedOverall) }]}>
                    {computedOverall !== null ? fmt(computedOverall, 2) : "—"}
                  </Text>
                </View>
                <View style={styles.overallSide}>
                  {mode === "log_visit" && existing ? (
                    <Text style={styles.overallSideText}>
                      Current avg{" "}
                      <Text style={{ color: ratingHex(existing.overall), fontWeight: "700" }}>
                        {fmt(existing.overall, 2)}
                      </Text>
                    </Text>
                  ) : null}
                  <Text style={styles.overallHint}>
                    {computedOverall === null
                      ? "Rate all 5 to compute"
                      : `weighted · food w=${weights.food}`}
                  </Text>
                </View>
              </View>
            ) : null}

            <ScrollView
              style={styles.flex1}
              contentContainerStyle={styles.formContent}
              keyboardShouldPersistTaps="handled"
            >
              {/* Place card */}
              <View style={styles.card}>
                {mode === "log_visit" ? (
                  <>
                    <Text style={styles.placeName}>{name}</Text>
                    <Text style={styles.placeSub}>
                      {[city, selectedCuisines.join(", "), category].filter(Boolean).join(" · ")}
                    </Text>
                    {existing ? (
                      <Pressable
                        onPress={() => selectExisting(existing, "edit")}
                        hitSlop={6}
                        style={styles.inlineLinkWrap}
                      >
                        <Text style={styles.inlineLink}>✎ Edit details instead</Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : (
                  <>
                    <TextInput
                      style={styles.nameInput}
                      value={name}
                      onChangeText={setName}
                      placeholder="Restaurant name"
                      placeholderTextColor="#57534e"
                    />
                    <View style={styles.cityRow}>
                      <Text style={styles.cityLabel}>📍</Text>
                      <TextInput
                        style={styles.cityInput}
                        value={city}
                        onChangeText={setCity}
                        placeholder="City"
                        placeholderTextColor="#57534e"
                      />
                    </View>
                    {address ? (
                      <Text style={styles.placeSub} numberOfLines={2}>
                        {address}
                      </Text>
                    ) : null}
                    {googleType ? (
                      <Text style={styles.googleType}>Google Maps: {googleType}</Text>
                    ) : null}
                    {mode === "edit" && existing && isRatedRestaurant(existing) ? (
                      <Pressable
                        onPress={() => selectExisting(existing, "log")}
                        hitSlop={6}
                        style={styles.inlineLinkWrap}
                      >
                        <Text style={styles.inlineLink}>+ Log a visit instead</Text>
                      </Pressable>
                    ) : null}
                  </>
                )}
              </View>

              {duplicateByName ? (
                <View style={styles.warnBanner}>
                  <Text style={styles.warnText}>
                    “{duplicateByName.name}” ({duplicateByName.city}) is already saved.
                  </Text>
                  <Pressable onPress={() => selectExisting(duplicateByName, "log")}>
                    <Text style={styles.inlineLink}>Use existing →</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* Rate vs Want to Go toggle */}
              {mode === "create" || mode === "rate_saved" ? (
                <View style={styles.segment}>
                  {(["rate", "want_to_go"] as const).map((m) => {
                    const active = entryMode === m;
                    return (
                      <Pressable
                        key={m}
                        onPress={() => {
                          haptic("select");
                          setEntryMode(m);
                        }}
                        style={cx(
                          styles.segmentItem,
                          active && (m === "rate" ? styles.segmentRate : styles.segmentWant),
                        )}
                      >
                        <Text style={active ? styles.segmentTextActive : styles.segmentText}>
                          {m === "rate" ? "⭐ Rate / Log Visit" : "🔖 Want to Go"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {/* Category + cuisines */}
              {showMetadata ? (
                <View style={styles.card}>
                  <Text style={styles.fieldLabel}>Category</Text>
                  <View style={styles.segmentSmall}>
                    {CATEGORIES.map((c) => (
                      <Pressable
                        key={c}
                        onPress={() => {
                          haptic("select");
                          setCategory(c);
                        }}
                        style={cx(styles.segmentItem, category === c && styles.segmentItemActive)}
                      >
                        <Text style={category === c ? styles.segmentTextActive : styles.segmentText}>
                          {c}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  <View style={styles.fieldLabelRow}>
                    <Text style={styles.fieldLabel}>Cuisines</Text>
                    <Text style={styles.fieldHint}>{selectedCuisines.length} selected</Text>
                  </View>
                  <View style={styles.chipWrap}>
                    {orderedCuisines.map((c) => {
                      const on = selectedCuisines.includes(c);
                      const isSuggested = c === suggestedCuisine;
                      return (
                        <Pressable
                          key={c}
                          onPress={() => toggleCuisine(c)}
                          style={cx(styles.cuisineChip, on && styles.cuisineChipOn)}
                        >
                          <Text style={on ? styles.cuisineTextOn : styles.cuisineText}>
                            {on ? "✓ " : ""}
                            {c}
                            {isSuggested && !on ? " ✨" : ""}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {!cuisineFilter.trim() ? (
                      <Pressable
                        onPress={() => setShowAllCuisines((v) => !v)}
                        style={styles.cuisineChipMore}
                      >
                        <Text style={styles.cuisineText}>
                          {showAllCuisines ? "Show less" : "+ More"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.cuisineSearchRow}>
                    <TextInput
                      style={styles.cuisineSearch}
                      value={cuisineFilter}
                      onChangeText={setCuisineFilter}
                      placeholder="Filter or add a cuisine…"
                      placeholderTextColor="#57534e"
                      autoCorrect={false}
                    />
                    {canAddTypedCuisine ? (
                      <Pressable
                        onPress={() => void addTypedCuisine()}
                        disabled={addingCuisine || !isAdmin}
                        style={styles.addCuisineBtn}
                      >
                        <Text style={styles.addCuisineText}>
                          {addingCuisine ? "Adding…" : `+ Add “${cuisineFilter.trim()}”`}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {/* Rating deck */}
              {showRatings
                ? RATING_FIELDS.map((f) => (
                    <RatingCard
                      key={f.key}
                      label={f.label}
                      hint={f.hint}
                      weight={weights[f.key]}
                      value={ratings[f.key]}
                      prior={priorRatings?.[f.key] ?? null}
                      allowClear={mode === "log_visit"}
                      onChange={(v) => setRating(f.key, v)}
                    />
                  ))
                : null}

              {/* Visit date */}
              {showRatings ? (
                <View style={styles.card}>
                  <Text style={styles.fieldLabel}>Visit date</Text>
                  <View style={styles.dateRow}>
                    {[
                      { label: "Today", value: today },
                      { label: "Yesterday", value: localIsoDate(new Date(Date.now() - 86400000)) },
                    ].map((d) => (
                      <Pressable
                        key={d.label}
                        onPress={() => {
                          haptic("select");
                          setVisitedOn(d.value);
                        }}
                        style={cx(styles.dateChip, visitedOn === d.value && styles.dateChipOn)}
                      >
                        <Text style={visitedOn === d.value ? styles.cuisineTextOn : styles.cuisineText}>
                          {d.label}
                        </Text>
                      </Pressable>
                    ))}
                    <TextInput
                      style={styles.dateInput}
                      value={visitedOn}
                      onChangeText={setVisitedOn}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor="#57534e"
                      keyboardType="default"
                      autoCorrect={false}
                      maxLength={10}
                    />
                  </View>
                </View>
              ) : null}

              {/* Note / comment */}
              <View style={styles.card}>
                <Text style={styles.fieldLabel}>
                  {mode === "log_visit" ? "Comment (this visit)" : "Note"}
                  <Text style={styles.fieldHint}> · optional</Text>
                </Text>
                <TextInput
                  style={styles.noteInput}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  placeholder={
                    mode === "log_visit"
                      ? "How was it this time? Dishes you ordered?"
                      : "Favorite dishes, tips, who to bring…"
                  }
                  placeholderTextColor="#57534e"
                />
              </View>

              {/* Photos */}
              <View style={styles.card}>
                <View style={styles.fieldLabelRow}>
                  <Text style={styles.fieldLabel}>Photos</Text>
                  <Text style={styles.fieldHint}>
                    {photos.length}/{MAX_PHOTOS}
                  </Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoRow}>
                  {existing?.photos?.map((url) => (
                    <Image key={url} source={{ uri: url }} style={styles.photoThumbExisting} />
                  ))}
                  {photos.map((p, i) => (
                    <Pressable
                      key={`${p.uri}-${i}`}
                      onPress={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Image source={{ uri: p.uri }} style={styles.photoThumb} />
                      <Text style={styles.photoRemove}>✕</Text>
                    </Pressable>
                  ))}
                  {photos.length < MAX_PHOTOS ? (
                    <>
                      <Pressable onPress={() => void addPhotos("camera")} style={styles.photoAdd}>
                        <Text style={styles.photoAddText}>📷{"\n"}Camera</Text>
                      </Pressable>
                      <Pressable onPress={() => void addPhotos("library")} style={styles.photoAdd}>
                        <Text style={styles.photoAddText}>🖼️{"\n"}Library</Text>
                      </Pressable>
                    </>
                  ) : null}
                </ScrollView>
              </View>

              {/* Receipt link */}
              {showRatings && (attachedReceipt || receiptSuggestions.length > 0) ? (
                <View style={styles.card}>
                  <Text style={styles.fieldLabel}>Receipt</Text>
                  {attachedReceipt ? (
                    <ReceiptPill
                      receipt={attachedReceipt}
                      attached
                      onPress={() => {
                        haptic("select");
                        setAttachReceiptId(null);
                      }}
                    />
                  ) : topReceipt ? (
                    <ReceiptPill
                      receipt={topReceipt}
                      attached={false}
                      onPress={() => {
                        haptic("light");
                        setAttachReceiptId(topReceipt.id);
                      }}
                    />
                  ) : null}
                  {receiptSuggestions.length > (attachedReceipt || topReceipt ? 1 : 0) ? (
                    <Pressable onPress={() => setShowReceiptList((v) => !v)} hitSlop={6}>
                      <Text style={[styles.inlineLink, { marginTop: 8 }]}>
                        {showReceiptList ? "Hide other receipts" : "Choose another unlinked receipt…"}
                      </Text>
                    </Pressable>
                  ) : null}
                  {showReceiptList
                    ? receiptSuggestions.slice(0, 6).map(({ rc }) =>
                        rc.id === attachReceiptId ? null : (
                          <ReceiptPill
                            key={rc.id}
                            receipt={rc}
                            attached={false}
                            onPress={() => {
                              haptic("light");
                              setAttachReceiptId(rc.id);
                              setShowReceiptList(false);
                            }}
                          />
                        ),
                      )
                    : null}
                </View>
              ) : null}
            </ScrollView>

            <View style={styles.footer}>
              {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
              {validationError && !saveError ? (
                <Text style={styles.validationText}>{validationError}</Text>
              ) : null}
              <Pressable
                onPress={() => void save()}
                disabled={saving}
                style={({ pressed }) =>
                  cx(
                    styles.saveBtn,
                    entryMode === "want_to_go" && mode !== "log_visit" && mode !== "edit"
                      ? styles.saveBtnWant
                      : null,
                    Boolean(validationError) && styles.saveBtnDisabled,
                    pressed && styles.pressed,
                  )
                }
              >
                {saving ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.saveText}>{saveLabel}</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Tactile 0–10 rating card: drag/tap slider (0.1 steps with selection haptics),
 * 6–10 integer anchor pills, ±0.1 nudges, and an optional prior-average tick.
 */
function RatingCard({
  label,
  hint,
  weight,
  value,
  prior,
  allowClear,
  onChange,
}: {
  label: string;
  hint: string;
  weight: number;
  value: number | null;
  prior: number | null;
  allowClear: boolean;
  onChange: (v: number | null) => void;
}) {
  const color = value === null ? "#57534e" : ratingHex(value);
  const nudge = (delta: number) => {
    haptic("light");
    onChange(round1((value ?? prior ?? 8) + delta));
  };
  return (
    <View style={styles.card}>
      <View style={styles.ratingHeader}>
        <View style={styles.flex1}>
          <Text style={styles.ratingLabel}>
            {label} <Text style={styles.weightText}>w={weight}</Text>
          </Text>
          <Text style={styles.ratingHint}>{hint}</Text>
        </View>
        <Text style={[styles.ratingValue, { color }]}>{value === null ? "—" : value.toFixed(1)}</Text>
      </View>
      <RatingSlider value={value} prior={prior} color={color} onChange={onChange} />
      <View style={styles.anchorRow}>
        <Pressable onPress={() => nudge(-0.1)} style={styles.nudgeBtn} hitSlop={4}>
          <Text style={styles.nudgeText}>−0.1</Text>
        </Pressable>
        {ANCHORS.map((a) => {
          const on = value !== null && Math.floor(value) === a;
          return (
            <Pressable
              key={a}
              onPress={() => {
                haptic("medium");
                onChange(a);
              }}
              style={cx(styles.anchor, on && { backgroundColor: ratingHex(a), borderColor: ratingHex(a) })}
            >
              <Text style={on ? styles.anchorTextOn : styles.anchorText}>{a}</Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => nudge(0.1)} style={styles.nudgeBtn} hitSlop={4}>
          <Text style={styles.nudgeText}>+0.1</Text>
        </Pressable>
        {allowClear && value !== null ? (
          <Pressable onPress={() => onChange(null)} hitSlop={6}>
            <Text style={styles.clearX}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function RatingSlider({
  value,
  prior,
  color,
  onChange,
}: {
  value: number | null;
  prior: number | null;
  color: string;
  onChange: (v: number) => void;
}) {
  const widthRef = useRef(0);
  const startXRef = useRef(0);
  const lastRef = useRef<number | null>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    lastRef.current = value;
  }, [value]);

  const pan = useMemo(() => {
    const setFromX = (x: number) => {
      const w = widthRef.current;
      if (w <= 0) return;
      const v = round1(Math.max(0, Math.min(10, (x / w) * 10)));
      if (v !== lastRef.current) {
        lastRef.current = v;
        Haptics.selectionAsync().catch(() => {});
        onChangeRef.current(v);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        startXRef.current = e.nativeEvent.locationX;
        setFromX(startXRef.current);
      },
      onPanResponderMove: (_e: GestureResponderEvent, g: PanState) => {
        setFromX(startXRef.current + g.dx);
      },
    });
  }, []);

  const pct = value === null ? 0 : value * 10;
  return (
    <View
      style={styles.sliderHit}
      onLayout={(e: LayoutChangeEvent) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      {...pan.panHandlers}
    >
      <View style={styles.sliderTrack} pointerEvents="none">
        <View style={[styles.sliderFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      {prior !== null ? (
        <View style={[styles.priorTick, { left: `${prior * 10}%` }]} pointerEvents="none" />
      ) : null}
      {value !== null ? (
        <View
          style={[styles.thumb, { left: `${pct}%`, borderColor: color }]}
          pointerEvents="none"
        />
      ) : null}
    </View>
  );
}

function ReceiptPill({
  receipt,
  attached,
  onPress,
}: {
  receipt: MobileReceiptRow;
  attached: boolean;
  onPress: () => void;
}) {
  const date = receipt.visited_on ?? receipt.created_at.slice(0, 10);
  return (
    <Pressable onPress={onPress} style={cx(styles.receiptPill, attached && styles.receiptPillOn)}>
      <Text style={attached ? styles.receiptPillTextOn : styles.receiptPillText} numberOfLines={1}>
        {attached ? "✓ Attached: " : "🧾 Attach "}${Number(receipt.total).toFixed(2)}
        {receipt.parsed_merchant ? ` · ${receipt.parsed_merchant}` : ""} · {formatVisitDate(date)}
      </Text>
      {attached ? <Text style={styles.receiptPillX}>✕</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0c0a09" },
  flex1: { flex: 1 },
  pressed: { opacity: 0.7 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#44403c",
    marginTop: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitle: { color: "#fafaf9", fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  headerLink: { color: "#10b981", fontSize: 16, fontWeight: "500" },
  headerSpacer: { width: 54 },
  lockBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(245,158,11,0.12)",
  },
  lockText: { color: "#fbbf24", fontSize: 12.5, flex: 1 },
  lockBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: "#f59e0b" },
  lockBtnText: { color: "#1c1917", fontWeight: "700", fontSize: 13 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  searchInput: { flex: 1, color: "#fafaf9", fontSize: 16, paddingVertical: 12 },
  searchResults: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 8 },
  sectionLabel: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 4,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#292524",
  },
  resultName: { color: "#fafaf9", fontSize: 15, fontWeight: "600" },
  resultSub: { color: "#78716c", fontSize: 12, marginTop: 2 },
  resultBadge: { color: "#a8a29e", fontSize: 12, fontWeight: "600" },
  manualRow: { paddingVertical: 14 },
  manualText: { color: "#10b981", fontSize: 14, fontWeight: "600" },
  searchHint: { color: "#57534e", fontSize: 13, marginTop: 18, textAlign: "center" },
  overallBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  overline: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  overallValue: { fontSize: 34, fontWeight: "800", letterSpacing: -0.5 },
  overallSide: { alignItems: "flex-end", gap: 2 },
  overallSideText: { color: "#a8a29e", fontSize: 13 },
  overallHint: { color: "#57534e", fontSize: 11 },
  formContent: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  card: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#292524",
  },
  placeName: { color: "#fafaf9", fontSize: 20, fontWeight: "800" },
  placeSub: { color: "#a8a29e", fontSize: 12.5, marginTop: 4 },
  googleType: { color: "#57534e", fontSize: 11, marginTop: 4 },
  nameInput: { color: "#fafaf9", fontSize: 20, fontWeight: "800", paddingVertical: 2 },
  cityRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  cityLabel: { fontSize: 13 },
  cityInput: {
    flex: 1,
    color: "#e7e5e4",
    fontSize: 14,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
  },
  inlineLinkWrap: { marginTop: 8 },
  inlineLink: { color: "#10b981", fontSize: 13, fontWeight: "600" },
  warnBanner: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(245,158,11,0.12)",
    gap: 6,
  },
  warnText: { color: "#fbbf24", fontSize: 13 },
  segment: {
    flexDirection: "row",
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: "#292524",
  },
  segmentSmall: {
    flexDirection: "row",
    backgroundColor: "#292524",
    borderRadius: 10,
    padding: 2,
    marginBottom: 14,
  },
  segmentItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segmentItemActive: { backgroundColor: "#44403c" },
  segmentRate: { backgroundColor: "#059669" },
  segmentWant: { backgroundColor: "#b45309" },
  segmentText: { color: "#a8a29e", fontSize: 13.5, fontWeight: "500" },
  segmentTextActive: { color: "#ffffff", fontSize: 13.5, fontWeight: "700" },
  fieldLabel: { color: "#d6d3d1", fontSize: 13, fontWeight: "600", marginBottom: 8 },
  fieldLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  fieldHint: { color: "#57534e", fontSize: 12, fontWeight: "400" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  cuisineChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  cuisineChipOn: { backgroundColor: "rgba(16,185,129,0.2)", borderColor: "#10b981" },
  cuisineChipMore: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#57534e",
  },
  cuisineText: { color: "#d6d3d1", fontSize: 13 },
  cuisineTextOn: { color: "#6ee7b7", fontSize: 13, fontWeight: "700" },
  cuisineSearchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  cuisineSearch: {
    flex: 1,
    color: "#e7e5e4",
    fontSize: 13.5,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
  },
  addCuisineBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#059669" },
  addCuisineText: { color: "#ffffff", fontSize: 12.5, fontWeight: "700" },
  ratingHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  ratingLabel: { color: "#fafaf9", fontSize: 15, fontWeight: "700" },
  weightText: { color: "#57534e", fontSize: 11, fontWeight: "500" },
  ratingHint: { color: "#78716c", fontSize: 12, marginTop: 1 },
  ratingValue: { fontSize: 26, fontWeight: "800", minWidth: 56, textAlign: "right" },
  sliderHit: { height: 36, justifyContent: "center", marginTop: 8 },
  sliderTrack: { height: 8, borderRadius: 4, backgroundColor: "#292524", overflow: "hidden" },
  sliderFill: { height: 8, borderRadius: 4 },
  priorTick: {
    position: "absolute",
    width: 2,
    height: 18,
    marginLeft: -1,
    top: 9,
    backgroundColor: "#a8a29e",
    opacity: 0.7,
  },
  thumb: {
    position: "absolute",
    width: 24,
    height: 24,
    marginLeft: -12,
    top: 6,
    borderRadius: 12,
    borderWidth: 3,
    backgroundColor: "#fafaf9",
  },
  anchorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  anchor: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: "center",
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  anchorText: { color: "#d6d3d1", fontSize: 14, fontWeight: "600" },
  anchorTextOn: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
  nudgeBtn: { paddingHorizontal: 8, paddingVertical: 8, borderRadius: 9, backgroundColor: "#1f1d1b" },
  nudgeText: { color: "#a8a29e", fontSize: 12, fontWeight: "600" },
  clearX: { color: "#78716c", fontSize: 14, paddingHorizontal: 4 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dateChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  dateChipOn: { backgroundColor: "rgba(16,185,129,0.2)", borderColor: "#10b981" },
  dateInput: {
    flex: 1,
    color: "#e7e5e4",
    fontSize: 14,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
    textAlign: "center",
  },
  noteInput: {
    color: "#e7e5e4",
    fontSize: 14.5,
    minHeight: 72,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
    textAlignVertical: "top",
  },
  photoRow: { gap: 8 },
  photoThumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: "#292524" },
  photoThumbExisting: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#292524",
    opacity: 0.55,
  },
  photoRemove: {
    position: "absolute",
    top: 3,
    right: 5,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
  },
  photoAdd: {
    width: 72,
    height: 72,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#57534e",
    alignItems: "center",
    justifyContent: "center",
  },
  photoAddText: { color: "#a8a29e", fontSize: 11, textAlign: "center" },
  receiptPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  receiptPillOn: { backgroundColor: "rgba(16,185,129,0.15)", borderColor: "#10b981" },
  receiptPillText: { color: "#d6d3d1", fontSize: 13, flex: 1 },
  receiptPillTextOn: { color: "#6ee7b7", fontSize: 13, fontWeight: "700", flex: 1 },
  receiptPillX: { color: "#6ee7b7", fontSize: 13 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#292524",
    backgroundColor: "#0c0a09",
    gap: 6,
  },
  validationText: { color: "#a8a29e", fontSize: 12, textAlign: "center" },
  errorText: { color: "#f87171", fontSize: 13, textAlign: "center", marginTop: 8 },
  saveBtn: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: "#059669",
  },
  saveBtnWant: { backgroundColor: "#b45309" },
  saveBtnDisabled: { opacity: 0.45 },
  saveText: { color: "#ffffff", fontSize: 16, fontWeight: "800" },
});
