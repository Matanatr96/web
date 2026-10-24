import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import type { Restaurant, RestaurantVisit } from "@web-lib/types";
import { RATING_WEIGHTS, fmt } from "@web-lib/utils";
import { isRatedRestaurant } from "@web-lib/restaurants-query";
import { VISIT_HALF_LIFE_DAYS } from "@web-lib/restaurant-visits";
import { computeSelfAverage, perDinerTotals } from "@web-lib/restaurant-receipts";
import {
  useRestaurants,
  type AddRateSheetParams,
} from "@/store/RestaurantsContext";
import { useAuth } from "@/auth/AuthContext";
import {
  DEFAULT_API_BASE_URL,
  deleteRestaurantMutation,
  deleteVisitMutation,
} from "@/api/client";
import type { MobileReceiptRow } from "@/api/supabase";

export type RestaurantDetailSheetProps = {
  restaurantId?: number | null;
  visible?: boolean;
  onClose?: () => void;
};

/** Delay between dismissing one RN `Modal` and presenting the next (iOS can't stack sibling modals). */
const SHEET_HANDOFF_DELAY_MS = 380;

/**
 * Hex color for a 0–10 rating, mirroring `pinColor` in
 * `components/restaurants-map.tsx` and `ratingColorClass` in `lib/utils.ts`.
 *
 * @param n - Rating value (or null/undefined when unrated).
 * @returns Hex color string.
 */
export function ratingHex(n: number | null | undefined): string {
  if (n === null || n === undefined) return "#78716c";
  if (n >= 9) return "#059669";
  if (n >= 8) return "#10b981";
  if (n >= 7) return "#65a30d";
  if (n >= 6) return "#d97706";
  if (n >= 5) return "#ea580c";
  return "#dc2626";
}

/** Amber accent used for unrated "Want to Go" bookmarks across the app. */
export const WANT_TO_GO_HEX = "#f59e0b";

/**
 * Hex color for how recently a restaurant was visited, mirroring
 * `lastVisitedColorClass` in `lib/utils.ts` (<1y emerald, <3y amber, else red).
 *
 * @param lastVisited - ISO date (`YYYY-MM-DD`) or null.
 * @returns Hex color string.
 */
export function lastVisitedHex(lastVisited: string | null | undefined): string {
  if (!lastVisited) return "#78716c";
  const ageYears =
    (Date.now() - new Date(`${lastVisited}T00:00:00`).getTime()) /
    (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 1) return "#10b981";
  if (ageYears < 3) return "#d97706";
  return "#dc2626";
}

/**
 * Format an ISO date (`YYYY-MM-DD`) as e.g. `Mar 4, 2026`.
 *
 * @param iso - ISO date string.
 * @returns Human-readable date, or an em dash when empty.
 */
export function formatVisitDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Prompt the user to open a restaurant in Apple Maps or Google Maps. Uses the
 * same Google Maps URL shape as the web map InfoWindow (`query_place_id`).
 *
 * @param r - Restaurant name, coordinates, address, and Google `place_id`.
 */
export function openRestaurantInMaps(
  r: Pick<Restaurant, "name" | "lat" | "lng" | "place_id" | "address">,
): void {
  const q = encodeURIComponent(r.name);
  const google = r.place_id
    ? `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${r.place_id}`
    : r.lat !== null && r.lng !== null
      ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.address ?? ""}`)}`;
  const apple =
    r.lat !== null && r.lng !== null
      ? `http://maps.apple.com/?q=${q}&ll=${r.lat},${r.lng}`
      : `http://maps.apple.com/?q=${encodeURIComponent(`${r.name} ${r.address ?? ""}`)}`;
  Alert.alert(r.name, "Open in…", [
    { text: "Apple Maps", onPress: () => void Linking.openURL(apple) },
    { text: "Google Maps", onPress: () => void Linking.openURL(google) },
    { text: "Cancel", style: "cancel" },
  ]);
}

/**
 * Compose a style array, dropping falsy entries (the local RN type shim does not
 * accept `null`/`false` inside style arrays).
 *
 * @param parts - Style objects or falsy placeholders.
 * @returns Array of truthy style objects.
 */
export function cx(...parts: (ViewStyle | null | false | undefined)[]): ViewStyle[] {
  return parts.filter((p): p is ViewStyle => Boolean(p));
}

function haptic(kind: "tap" | "success" | "warning" = "tap"): void {
  const p =
    kind === "tap"
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : Haptics.notificationAsync(
          kind === "success"
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
  p.catch(() => {});
}

type SubRatingRow = {
  key: "food" | "vegan_options" | "ambiance" | "value" | "service";
  label: string;
};

/** Ordered by weight (food dominates `computeOverall`). */
const SUB_RATING_ROWS: SubRatingRow[] = [
  { key: "food", label: "Food" },
  { key: "vegan_options", label: "Vegan Options" },
  { key: "ambiance", label: "Ambiance" },
  { key: "value", label: "Value for Money" },
  { key: "service", label: "Service" },
];

/**
 * Full Restaurant Dossier sheet — the iPhone replacement for
 * `app/restaurant/[id]/page.tsx` and the `/map` InfoWindow. Shows the hero
 * recency-weighted overall score, personal spend (`computeSelfAverage`), the 5
 * weighted sub-ratings, photo carousel, note, `restaurant_visits` timeline
 * (admin delete), and linked `receipts` with expandable dishes ordered
 * (`receipt_items`) and per-diner totals.
 *
 * Opened globally via `openRestaurantDetailSheet(id)`; hands off to the Add/Rate
 * and Receipt Split sheets by dismissing itself first.
 *
 * @param props - Optional overrides for `restaurantId`, `visible`, and `onClose`
 *   (defaults read from `useRestaurants().detailSheetState`).
 * @returns The modal sheet, or null when hidden.
 */
export default function RestaurantDetailSheet(props: RestaurantDetailSheetProps) {
  const {
    detailSheetState,
    closeRestaurantDetailSheet,
    restaurants,
    diners,
    fetchDetail,
    getCachedDetail,
    refreshAll,
    openAddRateSheet,
    openReceiptSplitSheet,
  } = useRestaurants();
  const { isAdmin, confirmDestructiveAction, openAuthModal } = useAuth();

  const visible = props.visible ?? detailSheetState.open;
  const restaurantId = props.restaurantId ?? detailSheetState.restaurantId;
  const handleClose = props.onClose ?? closeRestaurantDetailSheet;

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [expandedReceiptIds, setExpandedReceiptIds] = useState<Set<number>>(new Set());
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `fetchDetail` changes identity whenever the context's detail cache updates
  // (including after this very fetch), so read it through a ref to avoid a
  // refetch loop; only (re)fetch when the sheet opens or the id changes.
  const fetchDetailRef = useRef(fetchDetail);
  fetchDetailRef.current = fetchDetail;
  const getCachedDetailRef = useRef(getCachedDetail);
  getCachedDetailRef.current = getCachedDetail;

  useEffect(() => {
    if (!visible || restaurantId === null || restaurantId === undefined) return;
    let mounted = true;
    setLoadError(null);
    setExpandedReceiptIds(new Set());
    setIsLoadingDetail(!getCachedDetailRef.current(restaurantId));
    fetchDetailRef.current(restaurantId)
      .catch((e: unknown) => {
        if (mounted) setLoadError(e instanceof Error ? e.message : "Failed to load restaurant.");
      })
      .finally(() => {
        if (mounted) setIsLoadingDetail(false);
      });
    return () => {
      mounted = false;
    };
  }, [visible, restaurantId]);

  const detail = restaurantId !== null && restaurantId !== undefined ? getCachedDetail(restaurantId) : null;
  const restaurant: Restaurant | null =
    detail?.restaurant ?? restaurants.find((r) => r.id === restaurantId) ?? null;
  const visits: RestaurantVisit[] = detail?.visits ?? [];
  const receipts: MobileReceiptRow[] = detail?.receipts ?? [];

  const selfName = useMemo(
    () => diners.find((d) => d.is_self)?.name ?? "Anush",
    [diners],
  );
  const spend = useMemo(() => computeSelfAverage(receipts, selfName), [receipts, selfName]);

  const handoff = useCallback(
    (fn: () => void) => {
      handleClose();
      setTimeout(fn, SHEET_HANDOFF_DELAY_MS);
    },
    [handleClose],
  );

  const requireAdmin = useCallback(
    (fn: () => void) => {
      if (isAdmin) {
        fn();
        return;
      }
      handoff(openAuthModal);
    },
    [isAdmin, handoff, openAuthModal],
  );

  const onLogOrRate = useCallback(() => {
    if (!restaurant) return;
    haptic();
    requireAdmin(() => handoff(() => openAddRateSheet({ restaurantId: restaurant.id })));
  }, [restaurant, requireAdmin, handoff, openAddRateSheet]);

  const onEdit = useCallback(() => {
    if (!restaurant) return;
    haptic();
    // Extra `intent` field is read by AddRateVisitSheet (AddRateSheetIntentParams).
    const params: AddRateSheetParams & { intent: "edit" } = {
      restaurantId: restaurant.id,
      intent: "edit",
    };
    requireAdmin(() => handoff(() => openAddRateSheet(params)));
  }, [restaurant, requireAdmin, handoff, openAddRateSheet]);

  const onScanReceipt = useCallback(() => {
    if (!restaurant) return;
    haptic();
    handoff(() =>
      openReceiptSplitSheet({ restaurantId: restaurant.id, restaurantName: restaurant.name }),
    );
  }, [restaurant, handoff, openReceiptSplitSheet]);

  const onDeleteVisit = useCallback(
    (visit: RestaurantVisit) => {
      if (!restaurant) return;
      Alert.alert(
        "Delete visit?",
        `${formatVisitDate(visit.visited_on)} — ratings will be recomputed from the remaining visits.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              const ok = await confirmDestructiveAction(`Delete visit at ${restaurant.name}`);
              if (!ok) return;
              setBusy(true);
              try {
                await deleteVisitMutation(visit.id, restaurant.id);
                haptic("success");
                await Promise.all([fetchDetail(restaurant.id, true), refreshAll()]);
              } catch (e) {
                haptic("warning");
                Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    },
    [restaurant, confirmDestructiveAction, fetchDetail, refreshAll],
  );

  const onDeleteRestaurant = useCallback(() => {
    if (!restaurant) return;
    Alert.alert(
      `Delete ${restaurant.name}?`,
      "This removes the restaurant, its visit log, and its photos. Linked receipts are kept but unlinked.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const ok = await confirmDestructiveAction(`Delete ${restaurant.name}`);
            if (!ok) return;
            setBusy(true);
            try {
              await deleteRestaurantMutation(restaurant.id);
              haptic("success");
              handleClose();
              await refreshAll();
            } catch (e) {
              haptic("warning");
              Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [restaurant, confirmDestructiveAction, handleClose, refreshAll]);

  const toggleReceipt = useCallback((id: number) => {
    haptic();
    setExpandedReceiptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!visible || restaurantId === null || restaurantId === undefined) return null;

  const rated = restaurant ? isRatedRestaurant(restaurant) : false;
  const weights = restaurant
    ? (RATING_WEIGHTS[restaurant.category] ?? RATING_WEIGHTS.Food)
    : RATING_WEIGHTS.Food;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.grabber} />
        <View style={styles.topBar}>
          <View style={styles.flex1}>
            <Text style={styles.title} numberOfLines={2}>
              {restaurant?.name ?? `Restaurant #${restaurantId}`}
            </Text>
            {restaurant ? (
              <Text style={styles.meta} numberOfLines={2}>
                {[restaurant.city, restaurant.cuisines.join(", "), restaurant.category]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={handleClose} hitSlop={10} style={styles.doneBtn}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        {restaurant ? (
          <View style={styles.actionRow}>
            <ActionButton
              label={rated ? "+ Log Visit" : "⭐ Rate Now"}
              primary
              onPress={onLogOrRate}
            />
            <ActionButton label="🧾 Receipt" onPress={onScanReceipt} />
            <ActionButton label="📍 Maps" onPress={() => openRestaurantInMaps(restaurant)} />
            <ActionButton label={isAdmin ? "✎ Edit" : "🔒 Edit"} onPress={onEdit} />
          </View>
        ) : null}

        <ScrollView
          style={styles.flex1}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {loadError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{loadError}</Text>
            </View>
          ) : null}

          {!restaurant && isLoadingDetail ? (
            <ActivityIndicator style={styles.loader} color="#10b981" />
          ) : null}

          {restaurant ? (
            <>
              {/* Hero score & spend */}
              <View style={styles.card}>
                {rated ? (
                  <>
                    <View style={styles.heroRow}>
                      <View>
                        <Text style={styles.overline}>Overall</Text>
                        <Text style={[styles.heroScore, { color: ratingHex(restaurant.overall) }]}>
                          {fmt(restaurant.overall, 2)}
                        </Text>
                      </View>
                      <View style={styles.heroSide}>
                        <Text style={styles.heroSideText}>
                          {restaurant.visit_count ?? 0} visit
                          {(restaurant.visit_count ?? 0) === 1 ? "" : "s"}
                        </Text>
                        {restaurant.last_visited ? (
                          <Text
                            style={[
                              styles.heroSideSub,
                              { color: lastVisitedHex(restaurant.last_visited) },
                            ]}
                          >
                            Last {formatVisitDate(restaurant.last_visited)}
                          </Text>
                        ) : null}
                        <Text style={styles.recencyBadge}>
                          recency-weighted · {VISIT_HALF_LIFE_DAYS}d half-life
                        </Text>
                      </View>
                    </View>
                    {spend ? (
                      <Text style={styles.spendText}>
                        Avg spend per visit:{" "}
                        <Text style={styles.spendStrong}>${spend.avg.toFixed(2)}</Text>
                        <Text style={styles.muted}>
                          {" "}
                          · {spend.count} receipt{spend.count === 1 ? "" : "s"}
                        </Text>
                      </Text>
                    ) : null}
                    <View style={styles.subRatings}>
                      {SUB_RATING_ROWS.map((row) => {
                        const v = restaurant[row.key];
                        return (
                          <View key={row.key} style={styles.subRow}>
                            <View style={styles.subLabelRow}>
                              <Text style={styles.subLabel}>
                                {row.label}{" "}
                                <Text style={styles.weightText}>w={weights[row.key]}</Text>
                              </Text>
                              <Text style={[styles.subValue, { color: ratingHex(v) }]}>
                                {fmt(v)}
                              </Text>
                            </View>
                            <View style={styles.barTrack}>
                              <View
                                style={[
                                  styles.barFill,
                                  {
                                    width: `${Math.max(0, Math.min(10, v ?? 0)) * 10}%`,
                                    backgroundColor: ratingHex(v),
                                  },
                                ]}
                              />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                ) : (
                  <View>
                    <Text style={[styles.overline, { color: WANT_TO_GO_HEX }]}>🔖 Want to Go</Text>
                    <Text style={styles.unratedTitle}>Not rated yet</Text>
                    <Text style={styles.muted}>
                      Bookmarked for later. Tap “Rate Now” after your first visit to log ratings.
                    </Text>
                    {spend ? (
                      <Text style={[styles.spendText, { marginTop: 10 }]}>
                        Avg spend per visit:{" "}
                        <Text style={styles.spendStrong}>${spend.avg.toFixed(2)}</Text>
                      </Text>
                    ) : null}
                  </View>
                )}
                {restaurant.address ? (
                  <Pressable onPress={() => openRestaurantInMaps(restaurant)}>
                    <Text style={styles.address} numberOfLines={2}>
                      📍 {restaurant.address}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              {/* Photos */}
              {restaurant.photos && restaurant.photos.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.photoRow}
                >
                  {restaurant.photos.map((url) => (
                    <Pressable key={url} onPress={() => setViewerPhoto(url)}>
                      <Image source={{ uri: url }} style={styles.photo} resizeMode="cover" />
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}

              {/* Note */}
              {restaurant.note ? (
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>Note</Text>
                  <Text style={styles.noteText}>{restaurant.note}</Text>
                </View>
              ) : null}

              {/* Visit log */}
              <View style={styles.card}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Visit Log</Text>
                  {isLoadingDetail ? <ActivityIndicator size="small" color="#78716c" /> : null}
                </View>
                {visits.length === 0 ? (
                  <Text style={styles.muted}>
                    {isLoadingDetail ? "Loading visits…" : "No visits logged yet."}
                  </Text>
                ) : (
                  visits.map((v) => (
                    <View key={v.id} style={styles.visitRow}>
                      <View style={styles.visitHeader}>
                        <Text style={styles.visitDate}>{formatVisitDate(v.visited_on)}</Text>
                        <View style={styles.visitHeaderRight}>
                          {v.overall !== null ? (
                            <Text style={[styles.visitScore, { color: ratingHex(v.overall) }]}>
                              {fmt(v.overall, 2)}
                            </Text>
                          ) : null}
                          {isAdmin ? (
                            <Pressable
                              onPress={() => onDeleteVisit(v)}
                              hitSlop={8}
                              disabled={busy}
                              accessibilityLabel="Delete visit"
                            >
                              <Text style={styles.deleteLink}>Delete</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                      {v.comment ? <Text style={styles.visitComment}>{v.comment}</Text> : null}
                      <View style={styles.pillRow}>
                        {SUB_RATING_ROWS.map((row) =>
                          v[row.key] !== null ? (
                            <Text key={row.key} style={styles.miniPill}>
                              {row.key === "vegan_options" ? "Vegan" : row.label.split(" ")[0]}{" "}
                              <Text style={{ color: ratingHex(v[row.key]), fontWeight: "700" }}>
                                {fmt(v[row.key])}
                              </Text>
                            </Text>
                          ) : null,
                        )}
                      </View>
                    </View>
                  ))
                )}
              </View>

              {/* Receipts & dishes ordered */}
              <View style={styles.card}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Receipts & Dishes</Text>
                  <Pressable onPress={onScanReceipt} hitSlop={8}>
                    <Text style={styles.linkText}>+ Scan</Text>
                  </Pressable>
                </View>
                {receipts.length === 0 ? (
                  <Text style={styles.muted}>No linked receipts yet.</Text>
                ) : (
                  receipts.map((rc) => {
                    const expanded = expandedReceiptIds.has(rc.id);
                    const date = rc.visited_on ?? rc.created_at.slice(0, 10);
                    const totals = perDinerTotals(rc);
                    return (
                      <View key={rc.id} style={styles.receiptRow}>
                        <Pressable onPress={() => toggleReceipt(rc.id)} style={styles.receiptHeader}>
                          <View style={styles.flex1}>
                            <Text style={styles.visitDate}>{formatVisitDate(date)}</Text>
                            {totals.length > 0 ? (
                              <Text style={styles.receiptDiners} numberOfLines={expanded ? 4 : 1}>
                                {totals.map((t) => `${t.name} $${t.total.toFixed(2)}`).join(" · ")}
                              </Text>
                            ) : null}
                          </View>
                          <Text style={styles.receiptTotal}>
                            ${Number(rc.total).toFixed(2)} {expanded ? "▴" : "▾"}
                          </Text>
                        </Pressable>
                        {expanded ? (
                          <View style={styles.dishList}>
                            {rc.items.map((it) => (
                              <View key={it.id} style={styles.dishRow}>
                                <Text style={styles.dishName} numberOfLines={2}>
                                  {Number(it.qty) !== 1 ? `${Number(it.qty)}× ` : ""}
                                  {it.name}
                                </Text>
                                <Text style={styles.dishPrice}>
                                  ${(Number(it.price) * Number(it.qty)).toFixed(2)}
                                </Text>
                              </View>
                            ))}
                            <Pressable
                              onPress={() =>
                                void Linking.openURL(
                                  `${DEFAULT_API_BASE_URL.replace(/\/$/, "")}/restaurants/receipt/${rc.id}`,
                                )
                              }
                            >
                              <Text style={[styles.linkText, { marginTop: 8 }]}>
                                Open full split ↗
                              </Text>
                            </Pressable>
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                )}
              </View>

              {isAdmin ? (
                <Pressable
                  onPress={onDeleteRestaurant}
                  disabled={busy}
                  style={styles.dangerButton}
                >
                  <Text style={styles.dangerText}>
                    {busy ? "Working…" : `Delete ${restaurant.name}`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </ScrollView>

        {/* Full-screen photo viewer (rendered inside this modal's tree so it can stack). */}
        <Modal
          visible={viewerPhoto !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setViewerPhoto(null)}
        >
          <Pressable style={styles.viewerBackdrop} onPress={() => setViewerPhoto(null)}>
            {viewerPhoto ? (
              <Image source={{ uri: viewerPhoto }} style={styles.viewerImage} resizeMode="contain" />
            ) : null}
            <Text style={styles.viewerHint}>Tap to close</Text>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) =>
        cx(styles.actionBtn, primary && styles.actionBtnPrimary, pressed && styles.pressed)
      }
    >
      <Text style={primary ? styles.actionTextPrimary : styles.actionText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0c0a09" },
  flex1: { flex: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#44403c",
    marginTop: 8,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 18,
    paddingTop: 12,
    gap: 12,
  },
  title: { color: "#fafaf9", fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  meta: { color: "#a8a29e", fontSize: 13, marginTop: 4 },
  doneBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  doneText: { color: "#10b981", fontSize: 16, fontWeight: "600" },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    alignItems: "center",
  },
  actionBtnPrimary: { backgroundColor: "#059669", borderColor: "#10b981" },
  actionText: { color: "#e7e5e4", fontSize: 12.5, fontWeight: "600" },
  actionTextPrimary: { color: "#ffffff", fontSize: 12.5, fontWeight: "700" },
  pressed: { opacity: 0.7 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 48, gap: 14 },
  loader: { marginTop: 40 },
  errorBanner: {
    borderRadius: 10,
    padding: 12,
    backgroundColor: "rgba(220,38,38,0.15)",
    borderWidth: 1,
    borderColor: "#7f1d1d",
  },
  errorText: { color: "#fca5a5", fontSize: 13 },
  card: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#292524",
  },
  heroRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  overline: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  heroScore: { fontSize: 48, fontWeight: "800", letterSpacing: -1 },
  heroSide: { alignItems: "flex-end", gap: 2 },
  heroSideText: { color: "#e7e5e4", fontSize: 14, fontWeight: "600" },
  heroSideSub: { fontSize: 12 },
  recencyBadge: {
    marginTop: 4,
    color: "#a8a29e",
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "#292524",
    overflow: "hidden",
  },
  spendText: { color: "#a8a29e", fontSize: 13, marginTop: 8 },
  spendStrong: { color: "#e7e5e4", fontWeight: "700" },
  muted: { color: "#78716c", fontSize: 13 },
  subRatings: { marginTop: 14, gap: 10 },
  subRow: { gap: 5 },
  subLabelRow: { flexDirection: "row", justifyContent: "space-between" },
  subLabel: { color: "#d6d3d1", fontSize: 13 },
  weightText: { color: "#57534e", fontSize: 11 },
  subValue: { fontSize: 14, fontWeight: "700" },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: "#292524", overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
  unratedTitle: { color: "#fafaf9", fontSize: 20, fontWeight: "700", marginVertical: 4 },
  address: { color: "#a8a29e", fontSize: 12, marginTop: 12 },
  photoRow: { gap: 10 },
  photo: { width: 132, height: 132, borderRadius: 12, backgroundColor: "#292524" },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  noteText: { color: "#e7e5e4", fontSize: 15, lineHeight: 22 },
  visitRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#292524",
  },
  visitHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  visitHeaderRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  visitDate: { color: "#e7e5e4", fontSize: 14, fontWeight: "600" },
  visitScore: { fontSize: 14, fontWeight: "700" },
  deleteLink: { color: "#f87171", fontSize: 12, fontWeight: "600" },
  visitComment: { color: "#a8a29e", fontSize: 13, marginTop: 4, lineHeight: 18 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  miniPill: {
    color: "#a8a29e",
    fontSize: 11,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#292524",
    overflow: "hidden",
  },
  linkText: { color: "#10b981", fontSize: 13, fontWeight: "600" },
  receiptRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#292524",
  },
  receiptHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  receiptDiners: { color: "#78716c", fontSize: 12, marginTop: 2 },
  receiptTotal: { color: "#e7e5e4", fontSize: 14, fontWeight: "700" },
  dishList: { marginTop: 8, paddingLeft: 8, gap: 4 },
  dishRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  dishName: { color: "#d6d3d1", fontSize: 13, flex: 1 },
  dishPrice: { color: "#a8a29e", fontSize: 13 },
  dangerButton: {
    marginTop: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#7f1d1d",
    alignItems: "center",
  },
  dangerText: { color: "#f87171", fontSize: 14, fontWeight: "600" },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  viewerImage: { width: "100%", height: "80%" },
  viewerHint: { color: "#78716c", fontSize: 12, marginTop: 12 },
});
