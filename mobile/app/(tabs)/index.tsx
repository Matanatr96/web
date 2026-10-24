import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import MapView, { Marker, type Region } from "react-native-maps";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import type { Restaurant } from "@web-lib/types";
import { fmt } from "@web-lib/utils";
import {
  filterAdminRestaurants,
  isRatedRestaurant,
  type AdminStatusFilter,
} from "@web-lib/restaurants-query";
import { useRestaurants, type AddRateSheetParams } from "@/store/RestaurantsContext";
import { useAuth } from "@/auth/AuthContext";
import { deleteRestaurantMutation } from "@/api/client";
import {
  WANT_TO_GO_HEX,
  cx,
  formatVisitDate,
  lastVisitedHex,
  ratingHex,
} from "@/components/RestaurantDetailSheet";

type StatusFilter = "rated" | "want_to_go" | "all" | "missing_coords" | "missing_cuisine";
type SortKey =
  | "overall"
  | "food"
  | "value"
  | "service"
  | "ambiance"
  | "vegan_options"
  | "visit_count"
  | "last_visited"
  | "name"
  | "distance";
type SortDir = "asc" | "desc";
type Detent = "peek" | "medium" | "large";
type PickerKind = "status" | "city" | "category" | "cuisine" | "score" | "sort";
type Coords = { lat: number; lng: number };

const PEEK_HEIGHT = 168;
const LARGE_TOP = 10;
const NEAR_ME_RADII = [1, 3, 5, 10] as const;
const MIN_SCORES = [0, 7, 8, 9] as const;
const CATEGORIES = ["Food", "Drink", "Dessert"] as const;
const SF_REGION: Region = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

const STATUS_LABELS: Record<StatusFilter, string> = {
  rated: "Rated",
  want_to_go: "🔖 Want to Go",
  all: "All",
  missing_coords: "Missing Pin",
  missing_cuisine: "Missing Cuisine",
};

/** Maps the iPhone status filter onto `filterAdminRestaurants`' `AdminStatusFilter`. */
const STATUS_TO_ADMIN: Record<StatusFilter, AdminStatusFilter> = {
  rated: "rated",
  want_to_go: "unrated",
  all: "",
  missing_coords: "missing_coords",
  missing_cuisine: "missing_cuisine",
};

const SORT_OPTIONS: { key: SortKey; label: string; defaultDir: SortDir }[] = [
  { key: "overall", label: "Overall", defaultDir: "desc" },
  { key: "food", label: "Food", defaultDir: "desc" },
  { key: "vegan_options", label: "Vegan", defaultDir: "desc" },
  { key: "ambiance", label: "Ambiance", defaultDir: "desc" },
  { key: "value", label: "Value", defaultDir: "desc" },
  { key: "service", label: "Service", defaultDir: "desc" },
  { key: "visit_count", label: "Visits", defaultDir: "desc" },
  { key: "last_visited", label: "Last Visited", defaultDir: "desc" },
  { key: "name", label: "Name", defaultDir: "asc" },
  { key: "distance", label: "Distance", defaultDir: "asc" },
];

type PanState = { dx: number; dy: number; vx: number; vy: number };

/**
 * Great-circle distance in miles between two coordinates (Haversine).
 *
 * @param a - First coordinate.
 * @param b - Second coordinate.
 * @returns Distance in statute miles.
 */
function haversineMiles(a: Coords, b: Coords): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function tapHaptic(): void {
  Haptics.selectionAsync().catch(() => {});
}

/**
 * Tab 1 — Explore. Consolidates the web `/restaurants/table`, `/map`,
 * `/city/[city]`, `/cuisine/[cuisine]`, and `/admin/restaurants` views into an
 * Apple Maps–style canvas: color-coded score pins (amber 🔖 for unrated
 * "Want to Go" bookmarks) under a draggable 3-detent bottom sheet with search,
 * instant filter chips (status, Near Me/city, category, cuisine, min score,
 * sort), and admin long-press actions (Log Visit / Rate, Edit, Delete).
 *
 * Filtering reuses `filterAdminRestaurants` from `lib/restaurants-query.ts`;
 * Near Me, min-score, and extended sort keys are layered on top client-side.
 *
 * @returns The Explore tab screen.
 */
export default function ExploreTabScreen() {
  const {
    restaurants,
    isLoading,
    isSyncing,
    error,
    refreshAll,
    openRestaurantDetailSheet,
    openAddRateSheet,
  } = useRestaurants();
  const { isAdmin, openAuthModal, confirmDestructiveAction } = useAuth();

  // ── Filter state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("rated");
  const [city, setCity] = useState("");
  const [nearMe, setNearMe] = useState<Coords | null>(null);
  const [radiusMi, setRadiusMi] = useState<number>(3);
  const [category, setCategory] = useState("");
  const [cuisine, setCuisine] = useState("");
  const [minScore, setMinScore] = useState<number>(0);
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [locating, setLocating] = useState(false);

  const cities = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.city))).sort((a, b) => a.localeCompare(b)),
    [restaurants],
  );
  const cuisineOptions = useMemo(
    () =>
      Array.from(new Set(restaurants.flatMap((r) => r.cuisines))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [restaurants],
  );

  const visible = useMemo(() => {
    const base = filterAdminRestaurants(restaurants, {
      query,
      city: nearMe ? "" : city,
      cuisine,
      category,
      status: STATUS_TO_ADMIN[status],
      sortKey: "overall",
      sortDir: "desc",
    });
    const withDistance = base
      .map((r) => ({
        r,
        dist:
          nearMe && r.lat !== null && r.lng !== null
            ? haversineMiles(nearMe, { lat: r.lat, lng: r.lng })
            : null,
      }))
      .filter(({ r, dist }) => {
        if (minScore > 0 && (!isRatedRestaurant(r) || r.overall < minScore)) return false;
        if (nearMe && (dist === null || dist > radiusMi)) return false;
        return true;
      });

    const dir = sortDir === "asc" ? 1 : -1;
    withDistance.sort((a, b) => {
      const av = sortKey === "distance" ? a.dist : a.r[sortKey];
      const bv = sortKey === "distance" ? b.dist : b.r[sortKey];
      if ((av === null || av === undefined) && (bv === null || bv === undefined)) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return withDistance;
  }, [restaurants, query, city, nearMe, radiusMi, cuisine, category, status, minScore, sortKey, sortDir]);

  const pinned = useMemo(
    () =>
      visible
        .map((v) => ({
          r: v.r,
          dist: v.dist,
          lat: v.r.lat !== null && v.r.lat !== undefined ? Number(v.r.lat) : NaN,
          lng: v.r.lng !== null && v.r.lng !== undefined ? Number(v.r.lng) : NaN,
        }))
        .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng)),
    [visible],
  );

  const [selectedPinId, setSelectedPinId] = useState<number | null>(null);
  const selectedPin = useMemo(
    () => (selectedPinId !== null ? pinned.find((p) => p.r.id === selectedPinId) ?? null : null),
    [pinned, selectedPinId],
  );

  const hasActiveFilters = Boolean(
    query.trim() || city || nearMe || category || cuisine || minScore > 0 || status !== "rated",
  );

  const clearFilters = useCallback(() => {
    tapHaptic();
    setQuery("");
    setStatus("rated");
    setCity("");
    setNearMe(null);
    setCategory("");
    setCuisine("");
    setMinScore(0);
    if (sortKey === "distance") {
      setSortKey("overall");
      setSortDir("desc");
    }
  }, [sortKey]);

  // ── Map camera ──────────────────────────────────────────────────────────
  const mapRef = useRef<MapView | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const filterKey = `${query}|${status}|${city}|${nearMe ? `${nearMe.lat},${nearMe.lng},${radiusMi}` : ""}|${category}|${cuisine}|${minScore}`;
  const initialRegion = useMemo<Region>(() => {
    const sf = restaurants.filter(
      (r) => r.city === "San Francisco" && r.lat !== null && r.lng !== null,
    );
    const first = sf[0] ?? restaurants.find((r) => r.lat !== null && r.lng !== null);
    return first && first.lat !== null && first.lng !== null
      ? {
          latitude: Number(first.lat),
          longitude: Number(first.lng),
          latitudeDelta: 0.12,
          longitudeDelta: 0.12,
        }
      : SF_REGION;
    // Only computed for the first render; FitBounds effect handles later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const didInitialFit = useRef(false);
  const fitMapToPins = useCallback(
    (preferSf = false) => {
      if (!mapRef.current || !mapReady || pinned.length === 0) return;
      let pts = pinned;
      if (preferSf && !hasActiveFilters) {
        const sf = pinned.filter((p) => p.r.city === "San Francisco");
        if (sf.length > 0) pts = sf;
      }
      const coords = pts.map((p) => ({ latitude: p.lat, longitude: p.lng }));
      if (nearMe) coords.push({ latitude: nearMe.lat, longitude: nearMe.lng });
      if (coords.length === 1) {
        mapRef.current.animateToRegion(
          {
            latitude: coords[0].latitude,
            longitude: coords[0].longitude,
            latitudeDelta: 0.025,
            longitudeDelta: 0.025,
          },
          350,
        );
        return;
      }
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 72, right: 48, bottom: 260, left: 48 },
        animated: true,
      });
    },
    [mapReady, pinned, hasActiveFilters, nearMe],
  );

  useEffect(() => {
    if (!mapReady || pinned.length === 0) return;
    const preferSf = !didInitialFit.current;
    didInitialFit.current = true;
    const t = setTimeout(() => {
      fitMapToPins(preferSf);
    }, 200);
    return () => clearTimeout(t);
    // Refit when map finishes mounting, filter set changes, or catalog arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, filterKey, pinned.length > 0]);

  // ── Bottom sheet (3 detents anchored at bottom: 0 so Map hits work) ─────
  const [containerH, setContainerH] = useState(0);
  const [detent, setDetent] = useState<Detent>("medium");
  const detentHeights = useMemo(
    () => ({
      peek: PEEK_HEIGHT,
      medium: Math.max(PEEK_HEIGHT + 80, Math.round(containerH * 0.5)),
      large: Math.max(PEEK_HEIGHT + 160, containerH - LARGE_TOP),
    }),
    [containerH],
  );
  const detentHeightsRef = useRef(detentHeights);
  detentHeightsRef.current = detentHeights;
  const detentRef = useRef<Detent>(detent);
  detentRef.current = detent;
  const dragOffsetY = useRef(new Animated.Value(0)).current;

  const snapTo = useCallback(
    (d: Detent) => {
      dragOffsetY.setValue(0);
      setDetent(d);
    },
    [dragOffsetY],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e: GestureResponderEvent, g: PanState) =>
          Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e: GestureResponderEvent, g: PanState) => {
          dragOffsetY.setValue(g.dy);
        },
        onPanResponderRelease: (_e: GestureResponderEvent, g: PanState) => {
          const hMap = detentHeightsRef.current;
          const curH = hMap[detentRef.current];
          const projectedH = curH - (g.dy + g.vy * 120);
          const candidates: Detent[] = ["peek", "medium", "large"];
          const nearest = candidates.reduce((best, c) =>
            Math.abs(hMap[c] - projectedH) < Math.abs(hMap[best] - projectedH) ? c : best,
          );
          tapHaptic();
          snapTo(nearest);
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [dragOffsetY, snapTo],
  );

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerH(e.nativeEvent.layout.height);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────
  const enableNearMe = useCallback(async () => {
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Location off", "Enable location access in Settings to use Near Me.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setNearMe({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setCity("");
      setSortKey("distance");
      setSortDir("asc");
      tapHaptic();
    } catch (e) {
      Alert.alert("Couldn't get location", e instanceof Error ? e.message : String(e));
    } finally {
      setLocating(false);
    }
  }, []);

  const deleteRestaurant = useCallback(
    (r: Restaurant) => {
      Alert.alert(`Delete ${r.name}?`, "Removes its visit log and photos. Receipts are unlinked.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const ok = await confirmDestructiveAction(`Delete ${r.name}`);
            if (!ok) return;
            try {
              await deleteRestaurantMutation(r.id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              await refreshAll();
            } catch (e) {
              Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]);
    },
    [confirmDestructiveAction, refreshAll],
  );

  const showRowActions = useCallback(
    (r: Restaurant) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      if (!isAdmin) {
        Alert.alert(r.name, "Unlock admin mode to log visits or edit.", [
          { text: "Unlock", onPress: openAuthModal },
          { text: "View details", onPress: () => openRestaurantDetailSheet(r.id) },
          { text: "Cancel", style: "cancel" },
        ]);
        return;
      }
      const editParams: AddRateSheetParams & { intent: "edit" } = {
        restaurantId: r.id,
        intent: "edit",
      };
      Alert.alert(r.name, undefined, [
        {
          text: isRatedRestaurant(r) ? "+ Log Visit" : "⭐ Rate Now",
          onPress: () => openAddRateSheet({ restaurantId: r.id }),
        },
        { text: "✎ Edit Details", onPress: () => openAddRateSheet(editParams) },
        { text: "Delete", style: "destructive", onPress: () => deleteRestaurant(r) },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [isAdmin, openAuthModal, openRestaurantDetailSheet, openAddRateSheet, deleteRestaurant],
  );

  const sortLabel = SORT_OPTIONS.find((s) => s.key === sortKey)?.label ?? "Overall";
  const locationChipLabel = nearMe
    ? `📍 Near Me · ${radiusMi} mi`
    : city
      ? `🏙️ ${city}`
      : "📍 Anywhere";

  // ── Render ──────────────────────────────────────────────────────────────
  const renderRow = useCallback(
    ({ item }: { item: { r: Restaurant; dist: number | null } }) => {
      const r = item.r;
      const rated = isRatedRestaurant(r);
      return (
        <Pressable
          onPress={() => {
            tapHaptic();
            openRestaurantDetailSheet(r.id);
          }}
          onLongPress={() => showRowActions(r)}
          style={({ pressed }) => cx(styles.row, pressed && styles.rowPressed)}
        >
          <View style={styles.flex1}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {r.name}
              </Text>
              {!rated ? <Text style={styles.wantBadge}>Want to go</Text> : null}
            </View>
            <View style={styles.rowMetaLine}>
              <Pressable
                hitSlop={4}
                onPress={() => {
                  tapHaptic();
                  setNearMe(null);
                  setCity(r.city);
                }}
              >
                <Text style={styles.metaLink}>{r.city}</Text>
              </Pressable>
              {r.cuisines.map((c) => (
                <Pressable
                  key={c}
                  hitSlop={4}
                  onPress={() => {
                    tapHaptic();
                    setCuisine(c);
                  }}
                >
                  <Text style={styles.metaChip}>{c}</Text>
                </Pressable>
              ))}
              <Text style={styles.metaText}>· {r.category}</Text>
            </View>
            <View style={styles.rowSubLine}>
              <Text style={styles.metaText}>
                {r.visit_count} visit{r.visit_count === 1 ? "" : "s"}
              </Text>
              {r.last_visited ? (
                <Text style={[styles.metaText, { color: lastVisitedHex(r.last_visited) }]}>
                  · {formatVisitDate(r.last_visited)}
                </Text>
              ) : null}
              {item.dist !== null ? (
                <Text style={styles.metaText}>· {item.dist.toFixed(1)} mi</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.rowRight}>
            {rated ? (
              <View style={[styles.scoreBadge, { backgroundColor: ratingHex(r.overall) }]}>
                <Text style={styles.scoreText}>{fmt(r.overall, 2)}</Text>
              </View>
            ) : (
              <View style={[styles.scoreBadge, { backgroundColor: WANT_TO_GO_HEX }]}>
                <Text style={styles.scoreText}>🔖</Text>
              </View>
            )}
            {isAdmin ? (
              <Pressable hitSlop={10} onPress={() => showRowActions(r)}>
                <Text style={styles.moreDots}>•••</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [isAdmin, openRestaurantDetailSheet, showRowActions],
  );

  const sheetHeight = detentHeights[detent];

  return (
    <View style={styles.container} onLayout={onContainerLayout}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        onMapReady={() => setMapReady(true)}
        onPress={() => setSelectedPinId(null)}
        showsUserLocation={nearMe !== null}
        showsCompass
        showsScale
        pitchEnabled
        rotateEnabled
        zoomEnabled
        scrollEnabled
        showsPointsOfInterest={false}
        userInterfaceStyle="dark"
        mapPadding={{ top: 12, right: 12, bottom: Math.min(sheetHeight, 260), left: 12 }}
      >
        {pinned.map(({ r, lat, lng }) => {
          const rated = isRatedRestaurant(r);
          return (
            <Marker
              key={r.id}
              identifier={String(r.id)}
              coordinate={{ latitude: lat, longitude: lng }}
              title={`${r.name} · ${rated ? fmt(r.overall, 2) : "Want to Go"}`}
              description={`${r.cuisines.join(", ") || r.category} · ${r.city}`}
              pinColor={rated ? ratingHex(r.overall) : WANT_TO_GO_HEX}
              onPress={() => {
                tapHaptic();
                setSelectedPinId(r.id);
              }}
              onCalloutPress={() => {
                tapHaptic();
                openRestaurantDetailSheet(r.id);
              }}
              zIndex={rated ? Math.round(r.overall * 10) : 0}
            />
          );
        })}
      </MapView>

      {/* Floating Map Controls (visible whenever Map is uncovered) */}
      {detent !== "large" ? (
        <View style={styles.mapControls} pointerEvents="box-none">
          <Pressable
            onPress={() => {
              tapHaptic();
              fitMapToPins(false);
            }}
            style={styles.mapCtrlBtn}
            accessibilityLabel="Fit map to visible pins"
          >
            <Text style={styles.mapCtrlText}>🎯 Fit ({pinned.length})</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              tapHaptic();
              if (nearMe) {
                setNearMe(null);
              } else {
                void enableNearMe();
              }
            }}
            style={cx(styles.mapCtrlBtn, nearMe !== null && styles.mapCtrlBtnActive)}
            accessibilityLabel="Toggle Near Me"
          >
            <Text style={styles.mapCtrlText}>{nearMe ? "📍 Near Me ✓" : "📍 Near Me"}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Selected Pin Preview Card */}
      {selectedPin && detent !== "large" ? (
        <View style={[styles.pinPreviewWrap, { bottom: sheetHeight + 10 }]} pointerEvents="box-none">
          <Pressable
            onPress={() => {
              tapHaptic();
              openRestaurantDetailSheet(selectedPin.r.id);
            }}
            style={styles.pinPreviewCard}
          >
            <View style={styles.flex1}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {selectedPin.r.name}
              </Text>
              <Text style={styles.metaText} numberOfLines={1}>
                {selectedPin.r.city} · {selectedPin.r.cuisines.join(", ") || selectedPin.r.category}
              </Text>
            </View>
            <View
              style={[
                styles.scoreBadge,
                {
                  backgroundColor: isRatedRestaurant(selectedPin.r)
                    ? ratingHex(selectedPin.r.overall)
                    : WANT_TO_GO_HEX,
                },
              ]}
            >
              <Text style={styles.scoreText}>
                {isRatedRestaurant(selectedPin.r) ? fmt(selectedPin.r.overall, 2) : "🔖"}
              </Text>
            </View>
            <Pressable
              hitSlop={10}
              onPress={() => setSelectedPinId(null)}
              style={styles.pinPreviewClose}
            >
              <Text style={styles.metaText}>✕</Text>
            </Pressable>
          </Pressable>
        </View>
      ) : null}

      {containerH > 0 ? (
        <Animated.View
          style={[
            styles.sheet,
            { height: sheetHeight, transform: [{ translateY: dragOffsetY }] },
          ]}
        >
          {/* Drag zone: grabber + search + 3-way segmented toggle */}
          <View {...panResponder.panHandlers} style={styles.sheetHeader}>
            <Pressable
              onPress={() =>
                snapTo(detent === "peek" ? "medium" : detent === "medium" ? "large" : "peek")
              }
              hitSlop={10}
              style={styles.grabberHit}
            >
              <View style={styles.grabber} />
            </Pressable>
            <View style={styles.searchRow}>
              <TextInput
                style={styles.search}
                value={query}
                onChangeText={setQuery}
                onFocus={() => snapTo("large")}
                placeholder="Search name, city, or cuisine…"
                placeholderTextColor="#78716c"
                clearButtonMode="while-editing"
                returnKeyType="search"
                autoCorrect={false}
              />
              <Pressable
                onPress={() => {
                  tapHaptic();
                  if (isAdmin) openAddRateSheet();
                  else openAuthModal();
                }}
                style={styles.addBtn}
                accessibilityLabel="Add or rate restaurant"
              >
                <Text style={styles.addBtnText}>＋</Text>
              </Pressable>
            </View>
            <View style={styles.segment}>
              {(
                [
                  { key: "peek", label: "🗺️ Map" },
                  { key: "medium", label: "Split" },
                  { key: "large", label: "List" },
                ] as const
              ).map((m) => {
                const active = detent === m.key;
                return (
                  <Pressable
                    key={m.key}
                    onPress={() => {
                      tapHaptic();
                      snapTo(m.key);
                    }}
                    style={cx(styles.segmentItem, active && styles.segmentItemActive)}
                  >
                    <Text style={active ? styles.segmentTextActive : styles.segmentText}>
                      {m.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Filter chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
            keyboardShouldPersistTaps="handled"
          >
            <Chip
              label={STATUS_LABELS[status]}
              active={status !== "all"}
              onPress={() => setPicker("status")}
            />
            <Chip
              label={locating ? "Locating…" : locationChipLabel}
              active={Boolean(nearMe || city)}
              onPress={() => setPicker("city")}
            />
            <Chip
              label={category || "Category"}
              active={Boolean(category)}
              onPress={() => setPicker("category")}
            />
            <Chip
              label={cuisine || "Cuisine"}
              active={Boolean(cuisine)}
              onPress={() => setPicker("cuisine")}
            />
            <Chip
              label={minScore > 0 ? `${minScore}+` : "Min Score"}
              active={minScore > 0}
              onPress={() => setPicker("score")}
            />
            <Chip
              label={`↕ ${sortLabel} ${sortDir === "asc" ? "↑" : "↓"}`}
              active={sortKey !== "overall" || sortDir !== "desc"}
              onPress={() => setPicker("sort")}
            />
          </ScrollView>

          <View style={styles.countRow}>
            <Text style={styles.countText}>
              Showing {visible.length} of {restaurants.length}
              {pinned.length !== visible.length ? ` · ${visible.length - pinned.length} unpinned` : ""}
            </Text>
            {hasActiveFilters ? (
              <Pressable onPress={clearFilters} hitSlop={8}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>Sync failed: {error} — showing cached data.</Text>
            </View>
          ) : null}

          {isLoading && restaurants.length === 0 ? (
            <ActivityIndicator style={styles.loader} color="#10b981" />
          ) : (
            <FlatList
              data={visible}
              keyExtractor={(item) => String(item.r.id)}
              renderItem={renderRow}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={14}
              maxToRenderPerBatch={20}
              contentContainerStyle={{ paddingBottom: 36 }}
              refreshControl={
                <RefreshControl
                  refreshing={isSyncing}
                  onRefresh={() => void refreshAll()}
                  tintColor="#10b981"
                />
              }
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>No restaurants match these filters.</Text>
                  {hasActiveFilters ? (
                    <Pressable onPress={clearFilters} style={styles.emptyBtn}>
                      <Text style={styles.emptyBtnText}>Clear filters</Text>
                    </Pressable>
                  ) : null}
                </View>
              }
            />
          )}
        </Animated.View>
      ) : null}

      {/* Picker sheet */}
      <Modal
        visible={picker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setPicker(null)}>
          <Pressable style={styles.pickerSheet} onPress={() => {}}>
            <Text style={styles.pickerTitle}>
              {picker === "status"
                ? "Status"
                : picker === "city"
                  ? "Location"
                  : picker === "category"
                    ? "Category"
                    : picker === "cuisine"
                      ? "Cuisine"
                      : picker === "score"
                        ? "Minimum Score"
                        : "Sort By"}
            </Text>
            <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
              {picker === "status"
                ? (Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => (
                    <PickerOption
                      key={s}
                      label={STATUS_LABELS[s]}
                      selected={status === s}
                      onPress={() => {
                        setStatus(s);
                        setPicker(null);
                      }}
                    />
                  ))
                : null}
              {picker === "city" ? (
                <>
                  <PickerOption
                    label="📍 Anywhere"
                    selected={!nearMe && !city}
                    onPress={() => {
                      setNearMe(null);
                      setCity("");
                      if (sortKey === "distance") {
                        setSortKey("overall");
                        setSortDir("desc");
                      }
                      setPicker(null);
                    }}
                  />
                  {NEAR_ME_RADII.map((mi) => (
                    <PickerOption
                      key={`r${mi}`}
                      label={`📍 Near Me · within ${mi} mi`}
                      selected={Boolean(nearMe) && radiusMi === mi}
                      onPress={() => {
                        setRadiusMi(mi);
                        setPicker(null);
                        if (!nearMe) void enableNearMe();
                      }}
                    />
                  ))}
                  {cities.map((c) => (
                    <PickerOption
                      key={c}
                      label={`🏙️ ${c}`}
                      selected={!nearMe && city === c}
                      onPress={() => {
                        setNearMe(null);
                        setCity(c);
                        if (sortKey === "distance") {
                          setSortKey("overall");
                          setSortDir("desc");
                        }
                        setPicker(null);
                      }}
                    />
                  ))}
                </>
              ) : null}
              {picker === "category" ? (
                <>
                  <PickerOption
                    label="All categories"
                    selected={!category}
                    onPress={() => {
                      setCategory("");
                      setPicker(null);
                    }}
                  />
                  {CATEGORIES.map((c) => (
                    <PickerOption
                      key={c}
                      label={c}
                      selected={category === c}
                      onPress={() => {
                        setCategory(c);
                        setPicker(null);
                      }}
                    />
                  ))}
                </>
              ) : null}
              {picker === "cuisine" ? (
                <>
                  <PickerOption
                    label="All cuisines"
                    selected={!cuisine}
                    onPress={() => {
                      setCuisine("");
                      setPicker(null);
                    }}
                  />
                  {cuisineOptions.map((c) => (
                    <PickerOption
                      key={c}
                      label={c}
                      selected={cuisine === c}
                      onPress={() => {
                        setCuisine(c);
                        setPicker(null);
                      }}
                    />
                  ))}
                </>
              ) : null}
              {picker === "score"
                ? MIN_SCORES.map((s) => (
                    <PickerOption
                      key={s}
                      label={s === 0 ? "Any score" : `${s}+`}
                      selected={minScore === s}
                      onPress={() => {
                        setMinScore(s);
                        setPicker(null);
                      }}
                    />
                  ))
                : null}
              {picker === "sort"
                ? SORT_OPTIONS.filter((s) => s.key !== "distance" || nearMe).map((s) => (
                    <PickerOption
                      key={s.key}
                      label={
                        sortKey === s.key
                          ? `${s.label} ${sortDir === "asc" ? "↑ (tap to flip)" : "↓ (tap to flip)"}`
                          : s.label
                      }
                      selected={sortKey === s.key}
                      onPress={() => {
                        if (sortKey === s.key) {
                          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setSortKey(s.key);
                          setSortDir(s.defaultDir);
                        }
                        setPicker(null);
                      }}
                    />
                  ))
                : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={cx(styles.chip, active && styles.chipActive)}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText} numberOfLines={1}>
        {label} ▾
      </Text>
    </Pressable>
  );
}

function PickerOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => cx(styles.pickerOption, pressed && styles.rowPressed)}
    >
      <Text style={selected ? styles.pickerOptionTextSelected : styles.pickerOptionText}>
        {label}
      </Text>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0c0a09" },
  flex1: { flex: 1 },
  mapControls: {
    position: "absolute",
    top: 12,
    right: 12,
    gap: 8,
    alignItems: "flex-end",
  },
  mapCtrlBtn: {
    backgroundColor: "rgba(28, 25, 23, 0.92)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#44403c",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  mapCtrlBtnActive: {
    backgroundColor: "rgba(16, 185, 129, 0.22)",
    borderColor: "#10b981",
  },
  mapCtrlText: {
    color: "#fafaf9",
    fontSize: 12,
    fontWeight: "700",
  },
  pinPreviewWrap: {
    position: "absolute",
    left: 12,
    right: 12,
  },
  pinPreviewCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(28, 25, 23, 0.96)",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#44403c",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  pinPreviewClose: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: "#292524",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
  },
  sheetHeader: { paddingHorizontal: 14, paddingBottom: 6 },
  grabberHit: { alignItems: "center", paddingVertical: 8 },
  grabber: { width: 40, height: 5, borderRadius: 3, backgroundColor: "#44403c" },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  search: {
    flex: 1,
    backgroundColor: "#292524",
    color: "#fafaf9",
    fontSize: 15,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#059669",
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { color: "#ffffff", fontSize: 22, fontWeight: "700", marginTop: -2 },
  segment: {
    flexDirection: "row",
    marginTop: 10,
    backgroundColor: "#292524",
    borderRadius: 10,
    padding: 2,
  },
  segmentItem: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
  segmentItemActive: { backgroundColor: "#44403c" },
  segmentText: { color: "#a8a29e", fontSize: 13, fontWeight: "500" },
  segmentTextActive: { color: "#fafaf9", fontSize: 13, fontWeight: "700" },
  chipRow: { paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  chipActive: { backgroundColor: "rgba(16,185,129,0.18)", borderColor: "#10b981" },
  chipText: { color: "#d6d3d1", fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: "#6ee7b7", fontSize: 13, fontWeight: "700" },
  countRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  countText: { color: "#78716c", fontSize: 12 },
  clearText: { color: "#10b981", fontSize: 13, fontWeight: "600" },
  errorBanner: {
    marginHorizontal: 14,
    marginBottom: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: "rgba(217,119,6,0.15)",
  },
  errorText: { color: "#fbbf24", fontSize: 12 },
  loader: { marginTop: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#292524",
  },
  rowPressed: { backgroundColor: "#292524" },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { color: "#fafaf9", fontSize: 16, fontWeight: "700", flexShrink: 1 },
  wantBadge: {
    color: "#fbbf24",
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: "rgba(245,158,11,0.15)",
    overflow: "hidden",
  },
  rowMetaLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  metaLink: { color: "#a8a29e", fontSize: 12, textDecorationLine: "underline" },
  metaChip: {
    color: "#d6d3d1",
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: "#292524",
    overflow: "hidden",
  },
  metaText: { color: "#78716c", fontSize: 12 },
  rowSubLine: { flexDirection: "row", gap: 4, marginTop: 4 },
  rowRight: { alignItems: "center", gap: 6 },
  scoreBadge: {
    minWidth: 52,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: "center",
  },
  scoreText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  moreDots: { color: "#78716c", fontSize: 12, letterSpacing: 1 },
  empty: { alignItems: "center", paddingVertical: 40, gap: 12 },
  emptyTitle: { color: "#a8a29e", fontSize: 14 },
  emptyBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: "#292524",
  },
  emptyBtnText: { color: "#fafaf9", fontWeight: "600" },
  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  pickerSheet: {
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: 34,
    maxHeight: "70%",
  },
  pickerTitle: {
    color: "#fafaf9",
    fontSize: 17,
    fontWeight: "700",
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  pickerList: { paddingHorizontal: 8 },
  pickerOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
  },
  pickerOptionText: { color: "#d6d3d1", fontSize: 15 },
  pickerOptionTextSelected: { color: "#10b981", fontSize: 15, fontWeight: "700" },
  check: { color: "#10b981", fontSize: 16, fontWeight: "700" },
});
