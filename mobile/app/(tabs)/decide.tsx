import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import type { Restaurant } from "@web-lib/types";
import { fmt } from "@web-lib/utils";
import { bayesianScore, pickRandom } from "@web-lib/restaurants-query";
import { computeSelfAverage } from "@web-lib/restaurant-receipts";
import { useRestaurants } from "@/store/RestaurantsContext";
import { useAuth } from "@/auth/AuthContext";
import { fetchPlacesCache, type PlacesSuggestionItem } from "@/api/supabase";
import { saveRestaurantMutation, suggestUntriedPlaces } from "@/api/client";
import {
  VIBE_OPTIONS,
  detectNearestCity,
  rankRestaurantsByVibe,
  type RankedRestaurantMatch,
  type VibeMode,
  type VibeOption,
} from "../../src/lib/vibe-scoring";

type PoolTab = "rated" | "want_to_go" | "discover";
type LocationMode = "city" | "near_me";
type CategoryOption = "Food" | "Drink" | "Dessert";

const CATEGORIES: readonly CategoryOption[] = ["Food", "Drink", "Dessert"];
const RADIUS_OPTIONS: readonly number[] = [1, 3, 5, 10];
const MAX_DEFAULT_RESULTS = 4;
const MAX_PICK_THREE = 3;

function scoreBadgeColor(score: number): string {
  if (score >= 9) return "#059669"; // emerald-600
  if (score >= 8) return "#10b981"; // emerald-500
  if (score >= 7) return "#65a30d"; // lime-600
  if (score >= 6) return "#d97706"; // amber-600
  if (score >= 5) return "#ea580c"; // orange-600
  return "#dc2626"; // red-600
}

function defaultCategoryForHour(hour: number = new Date().getHours()): CategoryOption {
  if (hour >= 6 && hour < 10) return "Drink";
  if (hour >= 21 && hour <= 23) return "Dessert";
  return "Food";
}

/**
 * Tab 2: Decide — Single-Screen `< 1 ms` iPhone Recommendation Console.
 *
 * Combines GPS city/radius detection, 3-way Pool toggle (`Proven Favorites`,
 * `Want to Go`, `Discover New`), Category selector (`Food | Drink | Dessert`),
 * Cuisine carousel + `🎲 Pick 3 for Me` deterministic reshuffle drawer,
 * client-side Vibe Boost re-weighting, and interactive Match Cards with 1-tap
 * handoffs to Apple/Google Maps, `AddRateVisitSheet`, and `ReceiptSplitSheet`.
 *
 * @returns React element for the `Decide` tab screen.
 */
export default function DecideTabScreen() {
  const {
    restaurants,
    recentReceipts,
    refreshAll,
    openRestaurantDetailSheet,
    openAddRateSheet,
    openReceiptSplitSheet,
  } = useRestaurants();
  const { isAdmin, openAuthModal } = useAuth();

  // Location & GPS state
  const [locationMode, setLocationMode] = useState<LocationMode>("city");
  const [selectedCity, setSelectedCity] = useState<string>("");
  const [cityPickerOpen, setCityPickerOpen] = useState<boolean>(false);
  const [radiusMiles, setRadiusMiles] = useState<number>(3);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locatingGps, setLocatingGps] = useState<boolean>(false);
  const [gpsStatusNote, setGpsStatusNote] = useState<string | null>(null);

  // Pool, Category, Cuisine, Vibe state
  const [poolTab, setPoolTab] = useState<PoolTab>("rated");
  const [category, setCategory] = useState<CategoryOption>(() => defaultCategoryForHour());
  const [selectedCuisine, setSelectedCuisine] = useState<string>("");
  const [pickThreeOpen, setPickThreeOpen] = useState<boolean>(false);
  const [cuisineShuffle, setCuisineShuffle] = useState<number>(0);
  const [vibe, setVibe] = useState<VibeMode>("best_overall");
  const [showAllMatches, setShowAllMatches] = useState<boolean>(false);

  // Untried Google Places Discovery state
  const [includeUntriedInline, setIncludeUntriedInline] = useState<boolean>(false);
  const [untriedResults, setUntriedResults] = useState<PlacesSuggestionItem[] | null>(null);
  const [untriedCached, setUntriedCached] = useState<boolean>(false);
  const [untriedLoading, setUntriedLoading] = useState<boolean>(false);
  const [untriedError, setUntriedError] = useState<string | null>(null);
  const [savingPlaceId, setSavingPlaceId] = useState<string | null>(null);

  // Unique sorted cities with counts
  const cityCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of restaurants) {
      if (!r.city) continue;
      counts.set(r.city, (counts.get(r.city) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => a.city.localeCompare(b.city));
  }, [restaurants]);

  const allCities = useMemo(() => cityCounts.map((c) => c.city), [cityCounts]);

  // Ensure a default city is always selected once catalog hydrates
  useEffect(() => {
    if (!selectedCity && allCities.length > 0) {
      const defaultCity = allCities.includes("San Francisco")
        ? "San Francisco"
        : allCities[0];
      setSelectedCity(defaultCity);
    }
  }, [allCities, selectedCity]);

  // Request GPS location & auto-detect nearest city centroid on mount
  const triggerGpsDetect = useCallback(
    async (switchToNearMe: boolean = false) => {
      setLocatingGps(true);
      setGpsStatusNote(null);
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) {
          setGpsStatusNote("Location permission denied — using city filter.");
          setLocationMode("city");
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        setUserCoords(coords);

        const detected = detectNearestCity(coords.lat, coords.lng, restaurants, 25);
        if (detected) {
          setSelectedCity(detected);
          setGpsStatusNote(`Auto-detected ${detected}`);
        }
        if (switchToNearMe) {
          setLocationMode("near_me");
        }
      } catch {
        setGpsStatusNote("GPS unavailable — select a city manually.");
      } finally {
        setLocatingGps(false);
      }
    },
    [restaurants],
  );

  useEffect(() => {
    if (restaurants.length > 0 && !userCoords && !locatingGps) {
      triggerGpsDetect(false).catch(() => {});
    }
  }, [restaurants.length, userCoords, locatingGps, triggerGpsDetect]);

  // Categories available in current city/location
  const categoriesAvailable = useMemo(() => {
    const inLocation = restaurants.filter((r) => {
      if (locationMode === "near_me" && userCoords) {
        return r.lat !== null && r.lng !== null;
      }
      return !selectedCity || r.city === selectedCity;
    });
    const set = new Set(inLocation.map((r) => r.category));
    const filtered = CATEGORIES.filter((c) => set.has(c));
    return filtered.length > 0 ? filtered : CATEGORIES;
  }, [restaurants, locationMode, userCoords, selectedCity]);

  useEffect(() => {
    if (!categoriesAvailable.includes(category)) {
      setCategory(categoriesAvailable[0] ?? "Food");
    }
  }, [categoriesAvailable, category]);

  // Cuisines available in current (location + category)
  const cuisinesInScope = useMemo(() => {
    const freq = new Map<string, number>();
    for (const r of restaurants) {
      if (locationMode === "city" && selectedCity && r.city !== selectedCity) {
        continue;
      }
      if (r.category !== category) continue;
      for (const c of r.cuisines) {
        freq.set(c, (freq.get(c) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  }, [restaurants, locationMode, selectedCity, category]);

  // Deterministic 3-card cuisine subset ("🎲 Pick 3 for Me")
  const pickThreeOptions = useMemo(
    () => pickRandom(cuisinesInScope, MAX_PICK_THREE, cuisineShuffle),
    [cuisinesInScope, cuisineShuffle],
  );

  // Map of restaurantId -> linked receipts for instant personal average spend
  const receiptsByRestaurantId = useMemo(() => {
    const map = new Map<number, typeof recentReceipts>();
    for (const rc of recentReceipts) {
      if (rc.restaurant_id === null) continue;
      const list = map.get(rc.restaurant_id) ?? [];
      list.push(rc);
      map.set(rc.restaurant_id, list);
    }
    return map;
  }, [recentReceipts]);

  // Instant (< 1 ms) ranked personal matches
  const allRankedMatches = useMemo<RankedRestaurantMatch[]>(() => {
    if (poolTab === "discover") return [];
    return rankRestaurantsByVibe(restaurants, {
      pool: poolTab === "want_to_go" ? "want_to_go" : "rated",
      locationMode,
      city: selectedCity,
      userLocation: userCoords,
      radiusMiles,
      category,
      cuisine: selectedCuisine || null,
      vibe,
    });
  }, [
    restaurants,
    poolTab,
    locationMode,
    selectedCity,
    userCoords,
    radiusMiles,
    category,
    selectedCuisine,
    vibe,
  ]);

  const visibleMatches = useMemo(
    () =>
      showAllMatches
        ? allRankedMatches
        : allRankedMatches.slice(0, MAX_DEFAULT_RESULTS),
    [allRankedMatches, showAllMatches],
  );

  // Load untried Google Places suggestions (cache-first via Supabase, then API fallback)
  const effectiveUntriedCuisine =
    selectedCuisine || pickThreeOptions[0] || cuisinesInScope[0] || "Vegan";

  const loadUntriedSuggestions = useCallback(async () => {
    if (!selectedCity || !effectiveUntriedCuisine || !category) return;
    setUntriedLoading(true);
    setUntriedError(null);
    const cacheKey = `${selectedCity}|${effectiveUntriedCuisine}|${category}`.toLowerCase();
    try {
      const cachedHit = await fetchPlacesCache(cacheKey);
      if (cachedHit) {
        setUntriedResults(cachedHit);
        setUntriedCached(true);
        return;
      }
      const res = await suggestUntriedPlaces({
        city: selectedCity,
        cuisine: effectiveUntriedCuisine,
        category,
      });
      setUntriedResults(res.results);
      setUntriedCached(res.cached);
    } catch (e) {
      setUntriedError(
        e instanceof Error ? e.message : "Failed to load Google Places suggestions.",
      );
    } finally {
      setUntriedLoading(false);
    }
  }, [selectedCity, effectiveUntriedCuisine, category]);

  useEffect(() => {
    if (poolTab === "discover" || includeUntriedInline) {
      loadUntriedSuggestions().catch(() => {});
    }
  }, [poolTab, includeUntriedInline, loadUntriedSuggestions]);

  const handleOpenDirections = useCallback((r: Restaurant) => {
    Haptics.selectionAsync().catch(() => {});
    const encodedName = encodeURIComponent(r.name);
    const googleUrl = r.place_id
      ? `https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${r.place_id}`
      : r.lat !== null && r.lng !== null
        ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodedName}+${encodeURIComponent(r.city)}`;

    const appleUrl =
      r.lat !== null && r.lng !== null
        ? `maps://?q=${encodedName}&ll=${r.lat},${r.lng}`
        : `maps://?q=${encodedName}+${encodeURIComponent(r.city)}`;

    if (Platform.OS === "ios") {
      Alert.alert(r.name, "Open directions in:", [
        {
          text: "Apple Maps",
          onPress: () => {
            Linking.openURL(appleUrl).catch(() => Linking.openURL(googleUrl));
          },
        },
        {
          text: "Google Maps",
          onPress: () => {
            Linking.openURL(googleUrl).catch(() => {});
          },
        },
        { text: "Cancel", style: "cancel" },
      ]);
    } else {
      Linking.openURL(googleUrl).catch(() => {});
    }
  }, []);

  const handleSaveUntriedToWantToGo = useCallback(
    async (place: PlacesSuggestionItem) => {
      if (!isAdmin) {
        openAuthModal();
        return;
      }
      setSavingPlaceId(place.place_id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      try {
        await saveRestaurantMutation({
          name: place.name,
          city: selectedCity || "San Francisco",
          category,
          cuisines: [effectiveUntriedCuisine],
          unrated: true,
          overall: 0,
          lat: place.lat,
          lng: place.lng,
          place_id: place.place_id,
        });
        await refreshAll();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => {},
        );
        Alert.alert(
          "Saved to Want to Go",
          `${place.name} is now bookmarked in your Want to Go list.`,
        );
      } catch (e) {
        Alert.alert(
          "Could not save bookmark",
          e instanceof Error ? e.message : "Failed to save place.",
        );
      } finally {
        setSavingPlaceId(null);
      }
    },
    [isAdmin, openAuthModal, selectedCity, category, effectiveUntriedCuisine, refreshAll],
  );

  const activeVibeMeta = useMemo<VibeOption>(
    () => VIBE_OPTIONS.find((v: VibeOption) => v.key === vibe) ?? VIBE_OPTIONS[0],
    [vibe],
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.contentContainer}
      keyboardShouldPersistTaps="handled"
    >
      {/* 1. Context-Aware Location Header */}
      <View style={styles.headerBlock}>
        <View style={styles.headerTitleRow}>
          <View>
            <Text style={styles.screenTitle}>Decide Where to Eat</Text>
            <Text style={styles.screenSubtitle}>
              {gpsStatusNote ?? "Instant client-side matching across your ratings"}
            </Text>
          </View>
          <Pressable
            style={styles.resetButton}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setSelectedCuisine("");
              setVibe("best_overall");
              setPickThreeOpen(false);
              setShowAllMatches(false);
            }}
          >
            <Text style={styles.resetButtonText}>Reset</Text>
          </Pressable>
        </View>

        <View style={styles.locationToggleRow}>
          <Pressable
            style={
              locationMode === "near_me"
                ? [styles.locationPill, styles.locationPillActive]
                : styles.locationPill
            }
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              if (!userCoords) {
                triggerGpsDetect(true).catch(() => {});
              } else {
                setLocationMode("near_me");
              }
            }}
          >
            {locatingGps ? (
              <ActivityIndicator size="small" color="#fafaf9" />
            ) : (
              <Text
                style={
                  locationMode === "near_me"
                    ? [styles.locationPillText, styles.locationPillTextActive]
                    : styles.locationPillText
                }
              >
                📍 Near Me {userCoords ? `(< ${radiusMiles} mi)` : ""}
              </Text>
            )}
          </Pressable>

          <Pressable
            style={
              locationMode === "city"
                ? [styles.locationPill, styles.locationPillActive]
                : styles.locationPill
            }
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setLocationMode("city");
              setCityPickerOpen((prev) => !prev);
            }}
          >
            <Text
              style={
                locationMode === "city"
                  ? [styles.locationPillText, styles.locationPillTextActive]
                  : styles.locationPillText
              }
            >
              🏙️ {selectedCity || "Select City"} ▾
            </Text>
          </Pressable>
        </View>

        {locationMode === "near_me" && (
          <View style={styles.subChipRow}>
            {RADIUS_OPTIONS.map((rMi) => {
              const active = radiusMiles === rMi;
              return (
                <Pressable
                  key={rMi}
                  style={
                    active
                      ? [styles.smallChip, styles.smallChipActive]
                      : styles.smallChip
                  }
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setRadiusMiles(rMi);
                  }}
                >
                  <Text
                    style={
                      active
                        ? [styles.smallChipText, styles.smallChipTextActive]
                        : styles.smallChipText
                    }
                  >
                    &lt; {rMi} mi
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {locationMode === "city" && cityPickerOpen && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalScrollRow}
          >
            {cityCounts.map(({ city, count }) => {
              const active = city === selectedCity;
              return (
                <Pressable
                  key={city}
                  style={
                    active
                      ? [styles.smallChip, styles.smallChipActive]
                      : styles.smallChip
                  }
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setSelectedCity(city);
                    setSelectedCuisine("");
                    setCuisineShuffle(0);
                    setCityPickerOpen(false);
                  }}
                >
                  <Text
                    style={
                      active
                        ? [styles.smallChipText, styles.smallChipTextActive]
                        : styles.smallChipText
                    }
                  >
                    {city} ({count})
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* 2. 3-Way Pool Segmented Control */}
      <View style={styles.segmentedControl}>
        {(
          [
            { key: "rated", label: "★ Favorites" },
            { key: "want_to_go", label: "🔖 Want to Go" },
            { key: "discover", label: "✨ Discover New" },
          ] as const
        ).map((tab) => {
          const active = poolTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={
                active
                  ? [styles.segmentTab, styles.segmentTabActive]
                  : styles.segmentTab
              }
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setPoolTab(tab.key);
                setShowAllMatches(false);
              }}
            >
              <Text
                style={
                  active
                    ? [styles.segmentTabText, styles.segmentTabTextActive]
                    : styles.segmentTabText
                }
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 3. Category Selector (Food | Drink | Dessert) */}
      <View style={styles.sectionCard}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionLabel}>1. TYPE</Text>
          <Text style={styles.sectionHint}>Food, drink, or dessert?</Text>
        </View>
        <View style={styles.categoryRow}>
          {CATEGORIES.map((cat) => {
            const active = category === cat;
            const available = categoriesAvailable.includes(cat);
            const cardStyles = [
              styles.categoryCard,
              ...(active ? [styles.categoryCardActive] : []),
              ...(!available && poolTab !== "discover"
                ? [styles.categoryCardDisabled]
                : []),
            ];
            return (
              <Pressable
                key={cat}
                disabled={!available && poolTab !== "discover"}
                style={cardStyles}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setCategory(cat);
                  setSelectedCuisine("");
                  setCuisineShuffle(0);
                }}
              >
                <Text
                  style={
                    active
                      ? [styles.categoryCardText, styles.categoryCardTextActive]
                      : styles.categoryCardText
                  }
                >
                  {cat === "Food" ? "🍽️ Food" : cat === "Drink" ? "🍸 Drink" : "🍨 Dessert"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* 4. Cuisine Craving Carousel + "🎲 Pick 3 for Me" Reshuffle Game */}
        <View style={[styles.sectionHeaderRow, { marginTop: 14 }]}>
          <Text style={styles.sectionLabel}>2. CUISINE CRAVING</Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setPickThreeOpen((prev) => !prev);
            }}
          >
            <Text style={styles.pickThreeToggleText}>
              {pickThreeOpen ? "Show all chips" : "🎲 Can't decide? Pick 3"}
            </Text>
          </Pressable>
        </View>

        {pickThreeOpen ? (
          <View style={styles.pickThreeDrawer}>
            <Text style={styles.pickThreeSubtitle}>
              {cuisinesInScope.length > MAX_PICK_THREE
                ? `3 random ${category.toLowerCase()} cuisines in ${selectedCity || "range"}:`
                : `All ${category.toLowerCase()} cuisines in ${selectedCity || "range"}:`}
            </Text>
            <View style={styles.pickThreeCardsRow}>
              {pickThreeOptions.map((c) => {
                const active = selectedCuisine === c;
                return (
                  <Pressable
                    key={c}
                    style={
                      active
                        ? [styles.pickThreeCard, styles.pickThreeCardActive]
                        : styles.pickThreeCard
                    }
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      setSelectedCuisine(active ? "" : c);
                    }}
                  >
                    <Text
                      style={
                        active
                          ? [styles.pickThreeCardText, styles.pickThreeCardTextActive]
                          : styles.pickThreeCardText
                      }
                    >
                      {c}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {cuisinesInScope.length > MAX_PICK_THREE && (
              <Pressable
                style={styles.reshuffleButton}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                    () => {},
                  );
                  setCuisineShuffle((s) => s + 1);
                }}
              >
                <Text style={styles.reshuffleButtonText}>↻ Reshuffle 3 Cuisines</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalScrollRow}
          >
            <Pressable
              style={
                selectedCuisine === ""
                  ? [styles.cuisineChip, styles.cuisineChipActive]
                  : styles.cuisineChip
              }
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setSelectedCuisine("");
              }}
            >
              <Text
                style={
                  selectedCuisine === ""
                    ? [styles.cuisineChipText, styles.cuisineChipTextActive]
                    : styles.cuisineChipText
                }
              >
                All ({cuisinesInScope.length})
              </Text>
            </Pressable>
            {cuisinesInScope.map((c) => {
              const active = selectedCuisine === c;
              return (
                <Pressable
                  key={c}
                  style={
                    active
                      ? [styles.cuisineChip, styles.cuisineChipActive]
                      : styles.cuisineChip
                  }
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setSelectedCuisine(active ? "" : c);
                  }}
                >
                  <Text
                    style={
                      active
                        ? [styles.cuisineChipText, styles.cuisineChipTextActive]
                        : styles.cuisineChipText
                    }
                  >
                    {c}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* 5. Vibe / Priority Boost Chips (for Proven Favorites) */}
        {poolTab === "rated" && (
          <>
            <View style={[styles.sectionHeaderRow, { marginTop: 14 }]}>
              <Text style={styles.sectionLabel}>3. VIBE & PRIORITY BOOST</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.horizontalScrollRow}
            >
              {VIBE_OPTIONS.map((opt: VibeOption) => {
                const active = vibe === opt.key;
                return (
                  <Pressable
                    key={opt.key}
                    style={
                      active
                        ? [styles.vibeChip, styles.vibeChipActive]
                        : styles.vibeChip
                    }
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      setVibe(opt.key);
                    }}
                  >
                    <Text
                      style={
                        active
                          ? [styles.vibeChipText, styles.vibeChipTextActive]
                          : styles.vibeChipText
                      }
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.vibeFormulaCaption}>{activeVibeMeta.description}</Text>
          </>
        )}
      </View>

      {/* 6. Ranked Personal Match Cards (Proven Favorites & Want to Go) */}
      {poolTab !== "discover" && (
        <View style={styles.resultsSection}>
          <View style={styles.resultsHeaderRow}>
            <View>
              <Text style={styles.resultsTitle}>
                {category} · {selectedCuisine || "Any Cuisine"} ·{" "}
                {locationMode === "near_me" ? `Within ${radiusMiles} mi` : selectedCity}
              </Text>
              <Text style={styles.resultsSubtitle}>
                {allRankedMatches.length}{" "}
                {allRankedMatches.length === 1 ? "match" : "matches"} in{" "}
                {poolTab === "rated" ? "Proven Favorites" : "Want to Go"}
              </Text>
            </View>
            {allRankedMatches.length > MAX_DEFAULT_RESULTS && (
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setShowAllMatches((prev) => !prev);
                }}
              >
                <Text style={styles.showAllText}>
                  {showAllMatches
                    ? `Top ${MAX_DEFAULT_RESULTS} only`
                    : `Show all ${allRankedMatches.length}`}
                </Text>
              </Pressable>
            )}
          </View>

          {visibleMatches.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No matches in this combo</Text>
              <Text style={styles.emptySubtitle}>
                Try widening your cuisine filter, switching Vibe mode, or toggling{" "}
                &ldquo;Include places you haven&apos;t tried&rdquo; below.
              </Text>
            </View>
          ) : (
            visibleMatches.map((match, idx) => {
              const r = match.restaurant;
              const linkedReceipts = receiptsByRestaurantId.get(r.id) ?? [];
              const selfAvg = computeSelfAverage(linkedReceipts, "Anush");
              const isRated = r.food !== null;
              const displayScore =
                vibe === "best_overall" ? r.overall : match.vibeScore;

              return (
                <View key={r.id} style={styles.matchCard}>
                  <Pressable
                    onPress={() => openRestaurantDetailSheet(r.id)}
                    style={styles.matchCardTop}
                  >
                    <View style={styles.matchCardTitleCol}>
                      <View style={styles.rankAndNameRow}>
                        <Text style={styles.rankBadge}>#{idx + 1}</Text>
                        <Text style={styles.matchName}>{r.name}</Text>
                      </View>
                      <Text style={styles.matchMeta}>
                        {r.cuisines.join(", ") || r.category} · {r.city}
                      </Text>
                      <View style={styles.matchReasonPill}>
                        <Text style={styles.matchReasonText}>{match.matchReason}</Text>
                      </View>
                    </View>

                    {isRated ? (
                      <View style={styles.scoreBadgeCol}>
                        <View
                          style={[
                            styles.scoreCircle,
                            { backgroundColor: scoreBadgeColor(displayScore) },
                          ]}
                        >
                          <Text style={styles.scoreCircleText}>
                            {fmt(displayScore, 2)}
                          </Text>
                        </View>
                        {vibe !== "best_overall" && (
                          <Text style={styles.overallSubCaption}>
                            Overall {fmt(r.overall, 2)}
                          </Text>
                        )}
                      </View>
                    ) : (
                      <View style={styles.wantToGoBadge}>
                        <Text style={styles.wantToGoBadgeText}>🔖 Want to Go</Text>
                      </View>
                    )}
                  </Pressable>

                  {/* 5-Axis Sub-Rating Pill Strip */}
                  {isRated && (
                    <View style={styles.subRatingsStrip}>
                      {[
                        { label: "Food", val: r.food },
                        { label: "Vegan", val: r.vegan_options },
                        { label: "Value", val: r.value },
                        { label: "Vibe", val: r.ambiance },
                        { label: "Service", val: r.service },
                      ]
                        .filter((item) => item.val !== null)
                        .map((item) => (
                          <View key={item.label} style={styles.subRatingPill}>
                            <Text style={styles.subRatingPillLabel}>{item.label}</Text>
                            <Text style={styles.subRatingPillVal}>
                              {fmt(item.val, 1)}
                            </Text>
                          </View>
                        ))}
                    </View>
                  )}

                  {/* Visit Context & Avg Spend */}
                  <View style={styles.visitContextRow}>
                    <Text style={styles.visitContextText}>
                      {r.visit_count ?? 0} visit{(r.visit_count ?? 0) === 1 ? "" : "s"}
                      {r.last_visited ? ` · Last visited ${r.last_visited}` : ""}
                      {selfAvg ? ` · Avg $${selfAvg.avg.toFixed(2)}/visit` : ""}
                    </Text>
                  </View>

                  {r.note ? (
                    <Text style={styles.notePreview} numberOfLines={2}>
                      &ldquo;{r.note}&rdquo;
                    </Text>
                  ) : null}

                  {/* One-Tap Post-Match Action Bar */}
                  <View style={styles.cardActionsRow}>
                    <Pressable
                      style={styles.cardActionSecondary}
                      onPress={() => handleOpenDirections(r)}
                    >
                      <Text style={styles.cardActionSecondaryText}>🗺️ Directions</Text>
                    </Pressable>

                    <Pressable
                      style={styles.cardActionPrimary}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                          () => {},
                        );
                        openAddRateSheet({
                          restaurantId: r.id,
                          initialMode: "rate",
                        });
                      }}
                    >
                      <Text style={styles.cardActionPrimaryText}>
                        {isRated ? "✅ We Went Here" : "⭐ Rate First Visit"}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={styles.cardActionSecondary}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                          () => {},
                        );
                        openReceiptSplitSheet({
                          restaurantId: r.id,
                          restaurantName: r.name,
                        });
                      }}
                    >
                      <Text style={styles.cardActionSecondaryText}>🧾 Receipt</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}

          {/* Inline toggle matching web's "Include places you haven't tried (vegan-friendly)" */}
          <View style={styles.untriedToggleCard}>
            <View style={styles.untriedToggleTextCol}>
              <Text style={styles.untriedToggleTitle}>
                Include places you haven&apos;t tried (vegan-friendly)
              </Text>
              <Text style={styles.untriedToggleSubtitle}>
                Bayesian-ranked Google Places in {selectedCity || "this city"} for{" "}
                {effectiveUntriedCuisine} · {category}
              </Text>
            </View>
            <Switch
              value={includeUntriedInline}
              onValueChange={(next) => {
                Haptics.selectionAsync().catch(() => {});
                setIncludeUntriedInline(next);
              }}
              trackColor={{ false: "#44403c", true: "#10b981" }}
              thumbColor="#fafaf9"
            />
          </View>
        </View>
      )}

      {/* 7. Untried Vegan-Friendly Places Discovery Section */}
      {(poolTab === "discover" || includeUntriedInline) && (
        <View style={styles.resultsSection}>
          <View style={styles.resultsHeaderRow}>
            <View>
              <Text style={styles.resultsTitle}>
                ✨ New to Try · {effectiveUntriedCuisine} · {selectedCity}
              </Text>
              <Text style={styles.resultsSubtitle}>
                Operational, ≥4.0★, ≥50 reviews, vegan-friendly
                {untriedCached ? " · ⚡ Cached" : ""}
              </Text>
            </View>
            <Pressable onPress={() => loadUntriedSuggestions()}>
              <Text style={styles.showAllText}>↻ Refresh</Text>
            </Pressable>
          </View>

          {untriedLoading && (
            <View style={styles.emptyCard}>
              <ActivityIndicator size="small" color="#10b981" />
              <Text style={[styles.emptySubtitle, { marginTop: 8 }]}>
                Searching Google Places for vegan-friendly {effectiveUntriedCuisine}…
              </Text>
            </View>
          )}

          {untriedError && !untriedLoading && (
            <View style={styles.emptyCard}>
              <Text style={styles.errorText}>{untriedError}</Text>
            </View>
          )}

          {!untriedLoading &&
            !untriedError &&
            untriedResults &&
            untriedResults.length === 0 && (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>
                  No untried vegan-friendly places matched
                </Text>
                <Text style={styles.emptySubtitle}>
                  Try selecting a different cuisine chip or city above.
                </Text>
              </View>
            )}

          {!untriedLoading &&
            !untriedError &&
            untriedResults &&
            untriedResults.map((p) => {
              const bScore = bayesianScore(p.rating, p.user_rating_count);
              const isSaving = savingPlaceId === p.place_id;
              return (
                <View key={p.place_id} style={styles.untriedCard}>
                  <View style={styles.matchCardTop}>
                    <View style={styles.matchCardTitleCol}>
                      <Text style={styles.matchName}>{p.name}</Text>
                      <View style={styles.emeraldUntriedBadge}>
                        <Text style={styles.emeraldUntriedBadgeText}>
                          Untried · Vegan-friendly
                        </Text>
                      </View>
                    </View>
                    <View style={styles.untriedRatingCol}>
                      <Text style={styles.untriedStarText}>
                        {p.rating.toFixed(1)} ★
                      </Text>
                      <Text style={styles.untriedReviewCountText}>
                        {p.user_rating_count.toLocaleString()} reviews
                      </Text>
                      <Text style={styles.untriedBayesText}>
                        Bayes {bScore.toFixed(2)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.cardActionsRow}>
                    <Pressable
                      style={styles.cardActionSecondary}
                      onPress={() => {
                        Linking.openURL(p.maps_url).catch(() => {});
                      }}
                    >
                      <Text style={styles.cardActionSecondaryText}>🗺️ Maps</Text>
                    </Pressable>

                    <Pressable
                      style={styles.cardActionSecondary}
                      disabled={isSaving}
                      onPress={() => handleSaveUntriedToWantToGo(p)}
                    >
                      <Text style={styles.cardActionSecondaryText}>
                        {isSaving ? "Saving…" : "🔖 Want to Go"}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={styles.cardActionPrimary}
                      onPress={() => {
                        openAddRateSheet({
                          initialMode: "rate",
                          initialPlace: {
                            placeId: p.place_id,
                            name: p.name,
                            address: "",
                            city: selectedCity || "San Francisco",
                            lat: p.lat ?? 0,
                            lng: p.lng ?? 0,
                            matchedCuisine: effectiveUntriedCuisine,
                          },
                        });
                      }}
                    >
                      <Text style={styles.cardActionPrimaryText}>
                        ✅ Rate First Visit
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  headerBlock: {
    gap: 10,
  },
  headerTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#fafaf9",
  },
  screenSubtitle: {
    fontSize: 12,
    color: "#a8a29e",
    marginTop: 2,
  },
  resetButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  resetButtonText: {
    fontSize: 12,
    color: "#d6d3d1",
    fontWeight: "600",
  },
  locationToggleRow: {
    flexDirection: "row",
    gap: 8,
  },
  locationPill: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    alignItems: "center",
    justifyContent: "center",
  },
  locationPillActive: {
    backgroundColor: "#064e3b",
    borderColor: "#10b981",
  },
  locationPillText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#a8a29e",
  },
  locationPillTextActive: {
    color: "#ecfdf5",
  },
  subChipRow: {
    flexDirection: "row",
    gap: 8,
  },
  horizontalScrollRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
  },
  smallChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  smallChipActive: {
    backgroundColor: "#10b981",
    borderColor: "#10b981",
  },
  smallChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  smallChipTextActive: {
    color: "#0c0a09",
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: "#292524",
  },
  segmentTab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center",
  },
  segmentTabActive: {
    backgroundColor: "#292524",
  },
  segmentTabText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#78716c",
  },
  segmentTabTextActive: {
    color: "#fafaf9",
  },
  sectionCard: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 8,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: "#78716c",
  },
  sectionHint: {
    fontSize: 11,
    color: "#78716c",
  },
  categoryRow: {
    flexDirection: "row",
    gap: 8,
  },
  categoryCard: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#292524",
    backgroundColor: "#0c0a09",
    alignItems: "center",
  },
  categoryCardActive: {
    borderColor: "#10b981",
    backgroundColor: "#064e3b",
  },
  categoryCardDisabled: {
    opacity: 0.35,
  },
  categoryCardText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  categoryCardTextActive: {
    color: "#ecfdf5",
  },
  pickThreeToggleText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#10b981",
  },
  pickThreeDrawer: {
    backgroundColor: "#0c0a09",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 8,
  },
  pickThreeSubtitle: {
    fontSize: 12,
    color: "#a8a29e",
  },
  pickThreeCardsRow: {
    flexDirection: "row",
    gap: 8,
  },
  pickThreeCard: {
    flex: 1,
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#292524",
    backgroundColor: "#1c1917",
    alignItems: "center",
    justifyContent: "center",
  },
  pickThreeCardActive: {
    borderColor: "#10b981",
    backgroundColor: "#064e3b",
  },
  pickThreeCardText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fafaf9",
    textAlign: "center",
  },
  pickThreeCardTextActive: {
    color: "#ecfdf5",
  },
  reshuffleButton: {
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
  },
  reshuffleButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  cuisineChip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#0c0a09",
    borderWidth: 1,
    borderColor: "#292524",
  },
  cuisineChipActive: {
    backgroundColor: "#fafaf9",
    borderColor: "#fafaf9",
  },
  cuisineChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  cuisineChipTextActive: {
    color: "#0c0a09",
  },
  vibeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#0c0a09",
    borderWidth: 1,
    borderColor: "#292524",
  },
  vibeChipActive: {
    backgroundColor: "#064e3b",
    borderColor: "#10b981",
  },
  vibeChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  vibeChipTextActive: {
    color: "#ecfdf5",
  },
  vibeFormulaCaption: {
    fontSize: 11,
    color: "#78716c",
    marginTop: 2,
  },
  resultsSection: {
    gap: 10,
  },
  resultsHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  resultsTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fafaf9",
  },
  resultsSubtitle: {
    fontSize: 12,
    color: "#a8a29e",
    marginTop: 2,
  },
  showAllText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#10b981",
  },
  emptyCard: {
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "#292524",
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fafaf9",
  },
  emptySubtitle: {
    fontSize: 12,
    color: "#a8a29e",
    textAlign: "center",
    marginTop: 4,
    lineHeight: 18,
  },
  errorText: {
    fontSize: 13,
    color: "#f87171",
  },
  matchCard: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 10,
  },
  untriedCard: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "#44403c",
    gap: 10,
  },
  matchCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  matchCardTitleCol: {
    flex: 1,
    gap: 3,
  },
  rankAndNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rankBadge: {
    fontSize: 12,
    fontWeight: "800",
    color: "#10b981",
  },
  matchName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fafaf9",
    flexShrink: 1,
  },
  matchMeta: {
    fontSize: 12,
    color: "#a8a29e",
  },
  matchReasonPill: {
    alignSelf: "flex-start",
    marginTop: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#292524",
  },
  matchReasonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#d6d3d1",
  },
  scoreBadgeCol: {
    alignItems: "flex-end",
    gap: 3,
  },
  scoreCircle: {
    minWidth: 48,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  scoreCircleText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#fafaf9",
  },
  overallSubCaption: {
    fontSize: 10,
    color: "#a8a29e",
  },
  wantToGoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: "#451a03",
    borderWidth: 1,
    borderColor: "#d97706",
  },
  wantToGoBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fcd34d",
  },
  subRatingsStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  subRatingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#0c0a09",
    borderWidth: 1,
    borderColor: "#292524",
  },
  subRatingPillLabel: {
    fontSize: 11,
    color: "#78716c",
  },
  subRatingPillVal: {
    fontSize: 11,
    fontWeight: "700",
    color: "#e7e5e4",
  },
  visitContextRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  visitContextText: {
    fontSize: 11,
    color: "#78716c",
  },
  notePreview: {
    fontSize: 12,
    fontStyle: "italic",
    color: "#d6d3d1",
    lineHeight: 17,
  },
  cardActionsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  cardActionPrimary: {
    flex: 1.3,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 9,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
  },
  cardActionPrimaryText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0c0a09",
  },
  cardActionSecondary: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 9,
    backgroundColor: "#292524",
    alignItems: "center",
    justifyContent: "center",
  },
  cardActionSecondaryText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#e7e5e4",
  },
  untriedToggleCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 12,
  },
  untriedToggleTextCol: {
    flex: 1,
    gap: 2,
  },
  untriedToggleTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fafaf9",
  },
  untriedToggleSubtitle: {
    fontSize: 11,
    color: "#78716c",
  },
  emeraldUntriedBadge: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: "#064e3b",
  },
  emeraldUntriedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    color: "#6ee7b7",
  },
  untriedRatingCol: {
    alignItems: "flex-end",
    gap: 2,
  },
  untriedStarText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fafaf9",
  },
  untriedReviewCountText: {
    fontSize: 11,
    color: "#a8a29e",
  },
  untriedBayesText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#10b981",
  },
});
