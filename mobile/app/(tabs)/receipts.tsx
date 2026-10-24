import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  formatReceiptSplitText,
  round2,
  type ShareableDinerLineItem,
} from "@web-lib/receipts";
import {
  perDinerTotals,
  splitSavedReceipt,
  type SavedDinerBreakdown,
} from "@web-lib/restaurant-receipts";
import {
  DEFAULT_API_BASE_URL,
  autocompletePlaces,
  linkReceiptToPlace,
  parseReceiptImage,
  type AutocompletePlacePick,
} from "@/api/client";
import type { MobileReceiptRow } from "@/api/supabase";
import { useAuth } from "@/auth/AuthContext";
import { useRestaurants, type QueuedReceiptPhoto } from "@/store/RestaurantsContext";

type HistoryFilter = "all" | "orphans" | "unrated";

/**
 * Build the multi-line group-chat text summary (`formatReceiptSplitText`) for a
 * saved receipt row, including its universal web permalink.
 *
 * @param rc - Saved `MobileReceiptRow` from Supabase.
 * @returns Formatted chat string ready for iMessage, Signal, or WhatsApp.
 */
function buildSavedReceiptShareText(rc: MobileReceiptRow): {
  text: string;
  url: string;
  title: string;
  date: string;
  split: ReturnType<typeof splitSavedReceipt>;
} {
  const date = rc.visited_on ?? rc.created_at.slice(0, 10);
  const title = rc.restaurant?.name ?? rc.parsed_merchant ?? `Receipt #${rc.id}`;
  const url = `${DEFAULT_API_BASE_URL.replace(/\/$/, "")}/restaurants/receipt/${rc.id}`;
  const split = splitSavedReceipt(rc);

  const dinerItemsMap = new Map<number, ShareableDinerLineItem[]>();
  for (const p of split.per_diner) {
    dinerItemsMap.set(
      p.diner_id,
      p.items.map((it) => ({
        name: it.qty > 1 ? `${it.name} (${it.qty}×)` : it.name,
        share: it.share,
        splitCount: it.splitCount,
      })),
    );
  }

  const text = formatReceiptSplitText({
    title,
    date,
    perDiner: split.per_diner,
    dinerItems: dinerItemsMap,
    subtotal: split.subtotal,
    tax: split.tax,
    tip: split.tip,
    url,
  });

  return { text, url, title, date, split };
}

/**
 * Tab 3: Receipts — Native Receipt Scanner CTA, Offline-Resilient Active Draft
 * & Queued Photo Recovery Banner, and Filterable Split History (`All` /
 * `Unlinked Orphans` / `Unrated Places`) with expandable itemized breakdowns,
 * one-tap native iOS Share Sheet / Clipboard copy, Google Places orphan linking,
 * and `AddRateVisitSheet` handoff.
 *
 * @returns React element for the Receipts tab screen.
 */
export default function ReceiptsTabScreen() {
  const { isAdmin, openAuthModal } = useAuth();
  const {
    recentReceipts,
    isSyncing,
    refreshAll,
    activeReceiptDraft,
    setActiveReceiptDraft,
    clearActiveReceiptDraft,
    offlinePhotoQueue,
    removeOfflineReceiptPhoto,
    openReceiptSplitSheet,
    openAddRateSheet,
    openRestaurantDetailSheet,
  } = useRestaurants();

  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedReceiptIds, setExpandedReceiptIds] = useState<Set<number>>(new Set());
  const [expandedDinerKeys, setExpandedDinerKeys] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [retryingPhotoId, setRetryingPhotoId] = useState<string | null>(null);

  // Google Places Orphan Linker Modal State
  const [linkingReceipt, setLinkingReceipt] = useState<MobileReceiptRow | null>(null);
  const [placeQuery, setPlaceQuery] = useState<string>("");
  const [placeResults, setPlaceResults] = useState<AutocompletePlacePick[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<AutocompletePlacePick | null>(null);
  const [isSearchingPlaces, setIsSearchingPlaces] = useState<boolean>(false);
  const [isLinkingPlace, setIsLinkingPlace] = useState<boolean>(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const orphanCount = useMemo(
    () => recentReceipts.filter((r) => !r.restaurant_id && !r.restaurant).length,
    [recentReceipts],
  );

  const unratedCount = useMemo(
    () => recentReceipts.filter((r) => r.restaurant && r.restaurant.food === null).length,
    [recentReceipts],
  );

  const filteredReceipts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return recentReceipts.filter((rc) => {
      if (filter === "orphans" && (rc.restaurant_id || rc.restaurant)) return false;
      if (filter === "unrated" && (!rc.restaurant || rc.restaurant.food !== null)) return false;
      if (!q) return true;

      const label = (rc.restaurant?.name ?? rc.parsed_merchant ?? `Receipt #${rc.id}`).toLowerCase();
      const city = (rc.restaurant?.city ?? "").toLowerCase();
      const date = (rc.visited_on ?? rc.created_at.slice(0, 10)).toLowerCase();
      if (label.includes(q) || city.includes(q) || date.includes(q)) return true;

      for (const it of rc.items ?? []) {
        if (it.name.toLowerCase().includes(q)) return true;
        for (const a of it.assignments ?? []) {
          if (a.diner?.name?.toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }, [recentReceipts, filter, searchQuery]);

  const hasActiveDraft = Boolean(
    activeReceiptDraft &&
      (activeReceiptDraft.items.length > 0 ||
        activeReceiptDraft.savedId !== null ||
        activeReceiptDraft.step !== "upload"),
  );

  const toggleReceiptExpand = useCallback((id: number) => {
    Haptics.selectionAsync().catch(() => {});
    setExpandedReceiptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleDinerExpand = useCallback((receiptId: number, dinerId: number) => {
    Haptics.selectionAsync().catch(() => {});
    const key = `${receiptId}:${dinerId}`;
    setExpandedDinerKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCopySplit = useCallback(async (rc: MobileReceiptRow) => {
    const { text } = buildSavedReceiptShareText(rc);
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopiedId(rc.id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === rc.id ? null : prev));
    }, 2500);
  }, []);

  const handleNativeShare = useCallback(async (rc: MobileReceiptRow) => {
    const { text, url, title } = buildSavedReceiptShareText(rc);
    try {
      await Share.share({
        title: `${title} — Receipt Split`,
        message: text,
        url,
      });
    } catch {
      // Fallback to clipboard copy if Share Sheet was dismissed or failed
    }
  }, []);

  const handleRetryQueuedPhoto = useCallback(
    async (queued: QueuedReceiptPhoto) => {
      setRetryingPhotoId(queued.id);
      try {
        const { parsed, model } = await parseReceiptImage(queued.imageBase64, queued.mediaType);
        const items = parsed.items.map((it) => ({
          ...it,
          diner_ids: [] as number[],
        }));
        const computedSub = round2(items.reduce((s, i) => s + i.price * i.qty, 0));
        setActiveReceiptDraft({
          step: "review",
          parseModel: model ?? null,
          parsedMerchant: parsed.merchant ?? null,
          restaurantId: queued.restaurantId,
          items,
          subtotal: parsed.subtotal ?? computedSub,
          tax: parsed.tax ?? 0,
          tip: parsed.tip ?? 0,
          tipFromReceipt: parsed.tip != null,
          selectedDinerIds: [],
          savedId: null,
        });
        removeOfflineReceiptPhoto(queued.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        openReceiptSplitSheet({ resumeDraft: true, restaurantId: queued.restaurantId ?? undefined });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Still offline — try again when connected.";
        Alert.alert("Parse Failed", msg);
      } finally {
        setRetryingPhotoId(null);
      }
    },
    [setActiveReceiptDraft, removeOfflineReceiptPhoto, openReceiptSplitSheet],
  );

  const openOrphanLinker = useCallback(
    (rc: MobileReceiptRow) => {
      if (!isAdmin) {
        openAuthModal();
        return;
      }
      const seed = rc.parsed_merchant ?? "";
      setLinkingReceipt(rc);
      setPlaceQuery(seed);
      setPlaceResults([]);
      setSelectedPlace(null);
      setLinkError(null);
      if (seed.trim().length >= 2) {
        setIsSearchingPlaces(true);
        autocompletePlaces({ query: seed.trim() })
          .then((res) => {
            setPlaceResults(res);
            if (res.length > 0) setSelectedPlace(res[0]);
          })
          .catch((e) => {
            setLinkError(e instanceof Error ? e.message : "Places search failed");
          })
          .finally(() => setIsSearchingPlaces(false));
      }
    },
    [isAdmin, openAuthModal],
  );

  const runPlacesSearch = useCallback(async () => {
    const q = placeQuery.trim();
    if (!q) return;
    setIsSearchingPlaces(true);
    setLinkError(null);
    try {
      const res = await autocompletePlaces({ query: q });
      setPlaceResults(res);
      if (res.length > 0) setSelectedPlace(res[0]);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "Failed to search Google Places");
    } finally {
      setIsSearchingPlaces(false);
    }
  }, [placeQuery]);

  const confirmOrphanLink = useCallback(
    async (andRate: boolean) => {
      if (!linkingReceipt || !selectedPlace) return;
      setIsLinkingPlace(true);
      setLinkError(null);
      try {
        const res = await linkReceiptToPlace(linkingReceipt.id, {
          placeId: selectedPlace.placeId,
          name: selectedPlace.name,
          address: selectedPlace.address,
          city: selectedPlace.city,
          lat: selectedPlace.lat,
          lng: selectedPlace.lng,
          googleType: selectedPlace.googleType,
          googleTypeRaw: selectedPlace.googleTypeRaw,
        });
        const visitedOn = linkingReceipt.visited_on ?? linkingReceipt.created_at.slice(0, 10);
        const receiptId = linkingReceipt.id;
        setLinkingReceipt(null);
        await refreshAll();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

        if (andRate || res.is_new || !res.is_rated) {
          openAddRateSheet({
            restaurantId: res.restaurant_id,
            attachReceiptId: receiptId,
            visitedOn,
            initialMode: "rate",
          });
        }
      } catch (e) {
        setLinkError(e instanceof Error ? e.message : "Failed to link receipt");
      } finally {
        setIsLinkingPlace(false);
      }
    },
    [linkingReceipt, selectedPlace, refreshAll, openAddRateSheet],
  );

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isSyncing}
            onRefresh={() => {
              refreshAll().catch(() => {});
            }}
            tintColor="#10b981"
          />
        }
      >
        {/* Hero Scanner Launch Card */}
        <View style={styles.heroCard}>
          <View style={styles.heroHeaderRow}>
            <View style={styles.heroTextCol}>
              <Text style={styles.heroTitle}>Split a Receipt</Text>
              <Text style={styles.heroSubtitle}>
                Snap a receipt photo, tap diners per item, and share a live breakdown link in under 25 seconds.
              </Text>
            </View>
          </View>

          <View style={styles.heroActionsRow}>
            <Pressable
              style={styles.scanPrimaryBtn}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                openReceiptSplitSheet();
              }}
              accessibilityLabel="Scan Receipt with Camera or Photo Library"
            >
              <Text style={styles.scanPrimaryBtnText}>📷 Scan Receipt</Text>
            </Pressable>

            <Pressable
              style={styles.manualSecondaryBtn}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setActiveReceiptDraft({
                  step: "review",
                  parseModel: "manual",
                  parsedMerchant: null,
                  restaurantId: null,
                  items: [{ name: "", price: 0, qty: 1, diner_ids: [] }],
                  subtotal: 0,
                  tax: 0,
                  tip: 0,
                  tipFromReceipt: false,
                  selectedDinerIds: [],
                  savedId: null,
                });
                openReceiptSplitSheet({ resumeDraft: true });
              }}
              accessibilityLabel="Enter receipt items manually"
            >
              <Text style={styles.manualSecondaryBtnText}>✍️ Manual Entry</Text>
            </Pressable>
          </View>
        </View>

        {/* Active Draft Recovery Banner (MMKV / AsyncStorage persisted) */}
        {hasActiveDraft && activeReceiptDraft ? (
          <View style={styles.draftBanner}>
            <View style={styles.draftInfo}>
              <View style={styles.draftBadgeRow}>
                <View style={styles.liveDot} />
                <Text style={styles.draftTitle}>
                  Active Receipt Draft ({activeReceiptDraft.items.length}{" "}
                  {activeReceiptDraft.items.length === 1 ? "item" : "items"})
                </Text>
              </View>
              <Text style={styles.draftSubtitle}>
                {activeReceiptDraft.parsedMerchant
                  ? `${activeReceiptDraft.parsedMerchant} · `
                  : ""}
                Step: {activeReceiptDraft.step.toUpperCase()}
                {activeReceiptDraft.savedId ? ` · Saved #${activeReceiptDraft.savedId}` : ""}
              </Text>
            </View>
            <View style={styles.draftActions}>
              <Pressable
                style={styles.resumeDraftBtn}
                onPress={() => openReceiptSplitSheet({ resumeDraft: true })}
              >
                <Text style={styles.resumeDraftBtnText}>Resume →</Text>
              </Pressable>
              <Pressable
                style={styles.discardDraftBtn}
                onPress={() => {
                  clearActiveReceiptDraft();
                }}
              >
                <Text style={styles.discardDraftBtnText}>Discard</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Offline Queued Receipt Photos (Shaky restaurant Wi-Fi / Basement recovery) */}
        {offlinePhotoQueue.length > 0 ? (
          <View style={styles.offlineQueueCard}>
            <Text style={styles.offlineQueueTitle}>
              📡 Offline Receipt Queue ({offlinePhotoQueue.length})
            </Text>
            <Text style={styles.offlineQueueSubtitle}>
              Saved locally when cellular/Wi-Fi was unreachable. Tap retry to parse with Claude.
            </Text>
            {offlinePhotoQueue.map((q) => (
              <View key={q.id} style={styles.offlineQueueRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.offlineQueueItemTitle}>
                    Queued Photo · {new Date(q.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                  <Text style={styles.offlineQueueItemMeta}>
                    {Math.round((q.imageBase64.length * 3) / 4 / 1024)} KB compressed JPEG
                  </Text>
                </View>
                <Pressable
                  style={styles.retryQueueBtn}
                  onPress={() => handleRetryQueuedPhoto(q)}
                  disabled={retryingPhotoId === q.id}
                >
                  {retryingPhotoId === q.id ? (
                    <ActivityIndicator size="small" color="#fafaf9" />
                  ) : (
                    <Text style={styles.retryQueueBtnText}>Retry Parse</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.deleteQueueBtn}
                  onPress={() => removeOfflineReceiptPhoto(q.id)}
                >
                  <Text style={styles.deleteQueueBtnText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {/* Filter Chips & Search Bar for Recent Splits */}
        <View style={styles.historyHeaderSection}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionHeaderTitle}>RECENT SPLITS</Text>
            <Text style={styles.sectionHeaderCount}>
              Showing {filteredReceipts.length} of {recentReceipts.length}
            </Text>
          </View>

          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search merchant, diner, dish, or date…"
            placeholderTextColor="#78716c"
            clearButtonMode="while-editing"
          />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterPillsRow}
          >
            <Pressable
              style={[styles.filterPill, filter === "all" ? styles.filterPillActive : {}]}
              onPress={() => setFilter("all")}
            >
              <Text
                style={[
                  styles.filterPillText,
                  filter === "all" ? styles.filterPillTextActive : {},
                ]}
              >
                All Splits ({recentReceipts.length})
              </Text>
            </Pressable>

            <Pressable
              style={[styles.filterPill, filter === "orphans" ? styles.filterPillActive : {}]}
              onPress={() => setFilter("orphans")}
            >
              <Text
                style={[
                  styles.filterPillText,
                  filter === "orphans" ? styles.filterPillTextActive : {},
                ]}
              >
                📍 Unlinked Orphans ({orphanCount})
              </Text>
            </Pressable>

            <Pressable
              style={[styles.filterPill, filter === "unrated" ? styles.filterPillActive : {}]}
              onPress={() => setFilter("unrated")}
            >
              <Text
                style={[
                  styles.filterPillText,
                  filter === "unrated" ? styles.filterPillTextActive : {},
                ]}
              >
                ⭐ Unrated Places ({unratedCount})
              </Text>
            </Pressable>
          </ScrollView>
        </View>

        {/* Receipt Split Cards */}
        {filteredReceipts.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No matching receipts</Text>
            <Text style={styles.emptySubtitle}>
              {filter !== "all" || searchQuery.trim()
                ? "Try clearing your filter or search query."
                : "Snap a photo of your first restaurant bill above to split items across friends."}
            </Text>
          </View>
        ) : (
          filteredReceipts.map((rc) => {
            const date = rc.visited_on ?? rc.created_at.slice(0, 10);
            const linked = rc.restaurant;
            const isOrphan = !rc.restaurant_id && !linked;
            const isUnrated = Boolean(linked && linked.food === null);
            const label = linked?.name ?? rc.parsed_merchant ?? `Receipt #${rc.id}`;
            const dinersSummary = perDinerTotals(rc);
            const isExpanded = expandedReceiptIds.has(rc.id);
            const splitDetail = isExpanded ? splitSavedReceipt(rc) : null;

            return (
              <View key={rc.id} style={styles.receiptCard}>
                {/* Card Top Summary Row */}
                <Pressable
                  onPress={() => toggleReceiptExpand(rc.id)}
                  style={styles.receiptCardHeader}
                >
                  <View style={styles.receiptHeaderLeft}>
                    <View style={styles.receiptTitleRow}>
                      <Text style={styles.receiptTitle} numberOfLines={1}>
                        {label}
                      </Text>
                      {isOrphan ? (
                        <View style={styles.orphanBadge}>
                          <Text style={styles.orphanBadgeText}>unlinked</Text>
                        </View>
                      ) : null}
                      {isUnrated ? (
                        <View style={styles.unratedBadge}>
                          <Text style={styles.unratedBadgeText}>unrated</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.receiptMetaText}>
                      {date}
                      {linked?.city ? ` · ${linked.city}` : ""}
                      {rc.items?.length ? ` · ${rc.items.length} items` : ""}
                      {" · "}
                      <Text style={styles.expandHintText}>
                        {isExpanded ? "Hide breakdown ▴" : "View breakdown ▾"}
                      </Text>
                    </Text>
                  </View>

                  <View style={styles.receiptHeaderRight}>
                    <Text style={styles.receiptTotalAmount}>
                      ${Number(rc.total).toFixed(2)}
                    </Text>
                  </View>
                </Pressable>

                {/* Per-Diner Summary Pills */}
                {dinersSummary.length > 0 ? (
                  <View style={styles.dinerPillsWrap}>
                    {dinersSummary.map((d) => (
                      <View key={d.name} style={styles.dinerSummaryChip}>
                        <Text style={styles.dinerSummaryName}>{d.name}</Text>
                        <Text style={styles.dinerSummaryAmt}>${d.total.toFixed(2)}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {/* Expandable Full "Who Owes What" & Itemized Breakdown */}
                {isExpanded && splitDetail ? (
                  <View style={styles.expandedSection}>
                    <View style={styles.breakdownHeaderRow}>
                      <Text style={[styles.bdHeaderCell, { flex: 1.5 }]}>Diner</Text>
                      <Text style={styles.bdHeaderCellRight}>Items</Text>
                      <Text style={styles.bdHeaderCellRight}>+Tax</Text>
                      <Text style={styles.bdHeaderCellRight}>+Tip</Text>
                      <Text style={styles.bdHeaderCellRight}>Total</Text>
                    </View>

                    {splitDetail.per_diner.map((p: SavedDinerBreakdown) => {
                      const dinerKey = `${rc.id}:${p.diner_id}`;
                      const dinerOpen =
                        expandedDinerKeys.has(dinerKey) ||
                        splitDetail.per_diner.length <= 4;
                      return (
                        <View key={p.diner_id} style={styles.dinerBreakdownBlock}>
                          <Pressable
                            onPress={() => toggleDinerExpand(rc.id, p.diner_id)}
                            style={styles.dinerBreakdownRow}
                          >
                            <Text style={[styles.bdDinerName, { flex: 1.5 }]}>
                              {dinerOpen ? "▾ " : "▸ "}
                              {p.name}
                            </Text>
                            <Text style={styles.bdCell}>
                              ${p.items_total.toFixed(2)}
                            </Text>
                            <Text style={styles.bdCellMuted}>
                              ${p.tax_share.toFixed(2)}
                            </Text>
                            <Text style={styles.bdCellMuted}>
                              ${p.tip_share.toFixed(2)}
                            </Text>
                            <Text style={styles.bdCellBold}>
                              ${p.total.toFixed(2)}
                            </Text>
                          </Pressable>

                          {dinerOpen && p.items.length > 0 ? (
                            <View style={styles.dinerSubItemsList}>
                              {p.items.map((it, idx) => (
                                <View key={idx} style={styles.dinerSubItemRow}>
                                  <Text style={styles.dinerSubItemName}>
                                    • {it.name}
                                    {it.qty > 1 ? ` (${it.qty}×)` : ""}{" "}
                                    <Text style={styles.dinerSubItemSplit}>
                                      {it.splitCount === 1
                                        ? "(solo)"
                                        : `(split ${it.splitCount} ways)`}
                                    </Text>
                                  </Text>
                                  <Text style={styles.dinerSubItemShare}>
                                    ${it.share.toFixed(2)}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}

                    <View style={styles.breakdownFooterRow}>
                      <Text style={[styles.bdFooterLabel, { flex: 1.5 }]}>Total</Text>
                      <Text style={styles.bdCellMuted}>
                        ${splitDetail.subtotal.toFixed(2)}
                      </Text>
                      <Text style={styles.bdCellMuted}>
                        ${splitDetail.tax.toFixed(2)}
                      </Text>
                      <Text style={styles.bdCellMuted}>
                        ${splitDetail.tip.toFixed(2)}
                      </Text>
                      <Text style={styles.bdCellBold}>
                        ${splitDetail.total.toFixed(2)}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {/* Quick Action Bar */}
                <View style={styles.cardActionRow}>
                  <Pressable
                    style={styles.actionChip}
                    onPress={() => handleCopySplit(rc)}
                  >
                    <Text style={styles.actionChipText}>
                      {copiedId === rc.id ? "Copied ✓" : "📋 Copy Split"}
                    </Text>
                  </Pressable>

                  <Pressable
                    style={styles.actionChip}
                    onPress={() => handleNativeShare(rc)}
                  >
                    <Text style={styles.actionChipText}>📤 Share Link</Text>
                  </Pressable>

                  {isOrphan ? (
                    <Pressable
                      style={[styles.actionChip, styles.actionChipAccent]}
                      onPress={() => openOrphanLinker(rc)}
                    >
                      <Text style={styles.actionChipAccentText}>
                        📍 Link to Restaurant
                      </Text>
                    </Pressable>
                  ) : null}

                  {isUnrated && linked ? (
                    <Pressable
                      style={[styles.actionChip, styles.actionChipAmber]}
                      onPress={() =>
                        openAddRateSheet({
                          restaurantId: linked.id,
                          attachReceiptId: rc.id,
                          visitedOn: date,
                          initialMode: "rate",
                        })
                      }
                    >
                      <Text style={styles.actionChipAmberText}>
                        ⭐ Rate Restaurant →
                      </Text>
                    </Pressable>
                  ) : null}

                  {linked && !isUnrated ? (
                    <Pressable
                      style={styles.actionChip}
                      onPress={() => openRestaurantDetailSheet(linked.id)}
                    >
                      <Text style={styles.actionChipText}>🍽️ View Spot</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Google Places Orphan Receipt Linker Modal */}
      <Modal
        visible={linkingReceipt !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setLinkingReceipt(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Link Receipt to Restaurant</Text>
            <Text style={styles.modalSubtitle}>
              {linkingReceipt?.parsed_merchant
                ? `Claude saw "${linkingReceipt.parsed_merchant}" on Receipt #${linkingReceipt.id}. Pick the matching Google Place below:`
                : `Search Google Maps for the spot you visited on Receipt #${linkingReceipt?.id}:`}
            </Text>

            <View style={styles.placeSearchRow}>
              <TextInput
                style={styles.placeSearchInput}
                value={placeQuery}
                onChangeText={setPlaceQuery}
                placeholder="Search restaurant name & city…"
                placeholderTextColor="#78716c"
                onSubmitEditing={runPlacesSearch}
                returnKeyType="search"
              />
              <Pressable
                style={styles.placeSearchBtn}
                onPress={runPlacesSearch}
                disabled={isSearchingPlaces}
              >
                {isSearchingPlaces ? (
                  <ActivityIndicator size="small" color="#fafaf9" />
                ) : (
                  <Text style={styles.placeSearchBtnText}>Search</Text>
                )}
              </Pressable>
            </View>

            {linkError ? <Text style={styles.errorText}>{linkError}</Text> : null}

            <ScrollView style={styles.placeResultsList}>
              {placeResults.map((item) => {
                const isSelected = selectedPlace?.placeId === item.placeId;
                return (
                  <Pressable
                    key={item.placeId}
                    onPress={() => setSelectedPlace(item)}
                    style={[
                      styles.placeResultRow,
                      isSelected ? styles.placeResultRowSelected : {},
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.placeResultName}>{item.name}</Text>
                      <Text style={styles.placeResultAddr}>
                        {item.address}
                        {item.matchedCuisine ? ` · ${item.matchedCuisine}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.placeResultCheck}>
                      {isSelected ? "●" : "○"}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.modalButtonsCol}>
              <Pressable
                style={[
                  styles.modalPrimaryBtn,
                  !selectedPlace || isLinkingPlace ? styles.disabledBtn : {},
                ]}
                disabled={!selectedPlace || isLinkingPlace}
                onPress={() => confirmOrphanLink(true)}
              >
                {isLinkingPlace ? (
                  <ActivityIndicator size="small" color="#fafaf9" />
                ) : (
                  <Text style={styles.modalPrimaryBtnText}>
                    📍 Link & Rate Restaurant →
                  </Text>
                )}
              </Pressable>

              <Pressable
                style={[
                  styles.modalSecondaryBtn,
                  !selectedPlace || isLinkingPlace ? styles.disabledBtn : {},
                ]}
                disabled={!selectedPlace || isLinkingPlace}
                onPress={() => confirmOrphanLink(false)}
              >
                <Text style={styles.modalSecondaryBtnText}>Link Only</Text>
              </Pressable>

              <Pressable
                style={styles.modalCancelBtn}
                disabled={isLinkingPlace}
                onPress={() => setLinkingReceipt(null)}
              >
                <Text style={styles.modalCancelBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  heroCard: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 14,
  },
  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  heroTextCol: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#fafaf9",
  },
  heroSubtitle: {
    fontSize: 13,
    color: "#a8a29e",
    lineHeight: 18,
  },
  heroActionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  scanPrimaryBtn: {
    flex: 1.5,
    backgroundColor: "#10b981",
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  scanPrimaryBtnText: {
    color: "#064e3b",
    fontWeight: "800",
    fontSize: 15,
  },
  manualSecondaryBtn: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  manualSecondaryBtnText: {
    color: "#e7e5e4",
    fontWeight: "600",
    fontSize: 13,
  },
  draftBanner: {
    backgroundColor: "#064e3b",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#10b981",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  draftInfo: {
    flex: 1,
    gap: 3,
  },
  draftBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#34d399",
  },
  draftTitle: {
    color: "#ecfdf5",
    fontWeight: "700",
    fontSize: 14,
  },
  draftSubtitle: {
    color: "#a7f3d0",
    fontSize: 12,
  },
  draftActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resumeDraftBtn: {
    backgroundColor: "#10b981",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  resumeDraftBtnText: {
    color: "#064e3b",
    fontWeight: "700",
    fontSize: 12,
  },
  discardDraftBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  discardDraftBtnText: {
    color: "#a7f3d0",
    fontSize: 12,
  },
  offlineQueueCard: {
    backgroundColor: "#451a03",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#d97706",
    gap: 8,
  },
  offlineQueueTitle: {
    color: "#fef3c7",
    fontWeight: "700",
    fontSize: 14,
  },
  offlineQueueSubtitle: {
    color: "#fde68a",
    fontSize: 12,
  },
  offlineQueueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.25)",
    padding: 10,
    borderRadius: 10,
  },
  offlineQueueItemTitle: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "600",
  },
  offlineQueueItemMeta: {
    color: "#d6d3d1",
    fontSize: 11,
  },
  retryQueueBtn: {
    backgroundColor: "#d97706",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  retryQueueBtnText: {
    color: "#fafaf9",
    fontWeight: "700",
    fontSize: 12,
  },
  deleteQueueBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  deleteQueueBtnText: {
    color: "#fca5a5",
    fontSize: 18,
    fontWeight: "700",
  },
  historyHeaderSection: {
    gap: 10,
    marginTop: 4,
  },
  sectionTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  sectionHeaderTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: "#a8a29e",
  },
  sectionHeaderCount: {
    fontSize: 12,
    color: "#78716c",
  },
  searchInput: {
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fafaf9",
    fontSize: 14,
  },
  filterPillsRow: {
    flexDirection: "row",
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  filterPillActive: {
    backgroundColor: "#fafaf9",
    borderColor: "#fafaf9",
  },
  filterPillText: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "600",
  },
  filterPillTextActive: {
    color: "#0c0a09",
    fontWeight: "700",
  },
  emptyCard: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: "#292524",
    alignItems: "center",
    gap: 6,
  },
  emptyTitle: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "700",
  },
  emptySubtitle: {
    color: "#78716c",
    fontSize: 13,
    textAlign: "center",
  },
  receiptCard: {
    backgroundColor: "#1c1917",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 10,
  },
  receiptCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  receiptHeaderLeft: {
    flex: 1,
    gap: 4,
  },
  receiptTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  receiptTitle: {
    color: "#fafaf9",
    fontSize: 16,
    fontWeight: "700",
  },
  orphanBadge: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#57534e",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  orphanBadgeText: {
    color: "#d6d3d1",
    fontSize: 10,
    fontWeight: "600",
  },
  unratedBadge: {
    backgroundColor: "#451a03",
    borderWidth: 1,
    borderColor: "#d97706",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  unratedBadgeText: {
    color: "#fcd34d",
    fontSize: 10,
    fontWeight: "700",
  },
  receiptMetaText: {
    color: "#78716c",
    fontSize: 12,
  },
  expandHintText: {
    color: "#a8a29e",
    fontWeight: "500",
  },
  receiptHeaderRight: {
    alignItems: "flex-end",
  },
  receiptTotalAmount: {
    color: "#10b981",
    fontSize: 17,
    fontWeight: "800",
  },
  dinerPillsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  dinerSummaryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#292524",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  dinerSummaryName: {
    color: "#d6d3d1",
    fontSize: 12,
  },
  dinerSummaryAmt: {
    color: "#fafaf9",
    fontSize: 12,
    fontWeight: "700",
  },
  expandedSection: {
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 10,
    gap: 6,
  },
  breakdownHeaderRow: {
    flexDirection: "row",
    paddingBottom: 4,
  },
  bdHeaderCell: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "600",
  },
  bdHeaderCellRight: {
    flex: 1,
    color: "#78716c",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "right",
  },
  dinerBreakdownBlock: {
    borderTopWidth: 1,
    borderTopColor: "#262626",
    paddingTop: 6,
    gap: 4,
  },
  dinerBreakdownRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  bdDinerName: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "600",
  },
  bdCell: {
    flex: 1,
    color: "#e7e5e4",
    fontSize: 12,
    textAlign: "right",
  },
  bdCellMuted: {
    flex: 1,
    color: "#a8a29e",
    fontSize: 12,
    textAlign: "right",
  },
  bdCellBold: {
    flex: 1,
    color: "#10b981",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
  },
  dinerSubItemsList: {
    backgroundColor: "#141210",
    borderRadius: 8,
    padding: 8,
    gap: 3,
    marginTop: 2,
  },
  dinerSubItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  dinerSubItemName: {
    color: "#d6d3d1",
    fontSize: 11,
    flex: 1,
  },
  dinerSubItemSplit: {
    color: "#78716c",
  },
  dinerSubItemShare: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "600",
  },
  breakdownFooterRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#44403c",
    paddingTop: 6,
    marginTop: 2,
  },
  bdFooterLabel: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "700",
  },
  cardActionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 10,
  },
  actionChip: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  actionChipText: {
    color: "#e7e5e4",
    fontSize: 12,
    fontWeight: "600",
  },
  actionChipAccent: {
    backgroundColor: "#064e3b",
    borderColor: "#10b981",
  },
  actionChipAccentText: {
    color: "#a7f3d0",
    fontSize: 12,
    fontWeight: "700",
  },
  actionChipAmber: {
    backgroundColor: "#451a03",
    borderColor: "#d97706",
  },
  actionChipAmberText: {
    color: "#fde68a",
    fontSize: 12,
    fontWeight: "700",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    maxHeight: "85%",
    gap: 12,
  },
  modalTitle: {
    color: "#fafaf9",
    fontSize: 18,
    fontWeight: "700",
  },
  modalSubtitle: {
    color: "#a8a29e",
    fontSize: 13,
    lineHeight: 18,
  },
  placeSearchRow: {
    flexDirection: "row",
    gap: 8,
  },
  placeSearchInput: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fafaf9",
    fontSize: 14,
  },
  placeSearchBtn: {
    backgroundColor: "#10b981",
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  placeSearchBtnText: {
    color: "#064e3b",
    fontWeight: "700",
    fontSize: 13,
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
  },
  placeResultsList: {
    maxHeight: 220,
  },
  placeResultRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#292524",
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#44403c",
    gap: 10,
  },
  placeResultRowSelected: {
    borderColor: "#10b981",
    backgroundColor: "#064e3b",
  },
  placeResultName: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "700",
  },
  placeResultAddr: {
    color: "#a8a29e",
    fontSize: 12,
    marginTop: 2,
  },
  placeResultCheck: {
    color: "#10b981",
    fontSize: 16,
    fontWeight: "700",
  },
  modalButtonsCol: {
    gap: 8,
    marginTop: 4,
  },
  modalPrimaryBtn: {
    backgroundColor: "#10b981",
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  modalPrimaryBtnText: {
    color: "#064e3b",
    fontWeight: "800",
    fontSize: 14,
  },
  modalSecondaryBtn: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  modalSecondaryBtnText: {
    color: "#fafaf9",
    fontWeight: "600",
    fontSize: 13,
  },
  modalCancelBtn: {
    paddingVertical: 10,
    alignItems: "center",
  },
  modalCancelBtnText: {
    color: "#a8a29e",
    fontSize: 13,
  },
  disabledBtn: {
    opacity: 0.45,
  },
});
