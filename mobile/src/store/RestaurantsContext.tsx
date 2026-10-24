import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MMKV } from "react-native-mmkv";
import type { Restaurant } from "@web-lib/types";
import type { Diner, WizardItem } from "@web-lib/receipts";
import { partitionRestaurants } from "@web-lib/restaurants-query";
import {
  fetchCatalog,
  fetchRestaurantDetail,
  type CatalogPayload,
  type CuisineRow,
  type MobileReceiptRow,
  type RestaurantDetailPayload,
} from "@/api/supabase";
import type { AutocompletePlacePick } from "@/api/client";

const CATALOG_CACHE_KEY = "tlm_catalog_cache_v1";
const DETAIL_CACHE_PREFIX = "tlm_restaurant_detail_v1:";
export const RECEIPT_DRAFT_STORAGE_KEY = "receipt-wizard-draft-v1";
export const OFFLINE_PHOTO_QUEUE_KEY = "receipt-offline-photo-queue-v1";

export type ReceiptWizardStep =
  | "upload"
  | "review"
  | "diners"
  | "assign"
  | "tip"
  | "summary";

export type ReceiptWizardDraft = {
  step: ReceiptWizardStep;
  parseModel: string | null;
  parsedMerchant: string | null;
  restaurantId: number | null;
  items: WizardItem[];
  subtotal: number;
  tax: number;
  tip: number;
  tipFromReceipt: boolean;
  selectedDinerIds: number[];
  savedId: number | null;
  updatedAt?: string;
};

export type QueuedReceiptPhoto = {
  id: string;
  imageBase64: string;
  mediaType: string;
  restaurantId: number | null;
  createdAt: string;
};

export type AddRateSheetParams = {
  restaurantId?: number;
  initialPlace?: AutocompletePlacePick;
  initialMode?: "rate" | "want_to_go";
  attachReceiptId?: number;
  visitedOn?: string;
};

export type ReceiptSplitSheetParams = {
  restaurantId?: number;
  restaurantName?: string;
  receiptId?: number;
  resumeDraft?: boolean;
};

export type RestaurantsContextValue = {
  restaurants: Restaurant[];
  ratedRestaurants: Restaurant[];
  wantToGoRestaurants: Restaurant[];
  cuisines: CuisineRow[];
  diners: Diner[];
  recentReceipts: MobileReceiptRow[];
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  error: string | null;
  refreshAll: () => Promise<void>;
  fetchDetail: (restaurantId: number, forceRefresh?: boolean) => Promise<RestaurantDetailPayload>;
  getCachedDetail: (restaurantId: number) => RestaurantDetailPayload | null;

  // Receipt draft & offline queue
  activeReceiptDraft: ReceiptWizardDraft | null;
  setActiveReceiptDraft: (draft: ReceiptWizardDraft | null) => void;
  clearActiveReceiptDraft: () => void;
  offlinePhotoQueue: QueuedReceiptPhoto[];
  enqueueOfflineReceiptPhoto: (photo: Omit<QueuedReceiptPhoto, "id" | "createdAt">) => void;
  removeOfflineReceiptPhoto: (id: string) => void;

  // Global Sheet Navigation State & Triggers
  detailSheetState: { open: boolean; restaurantId: number | null };
  openRestaurantDetailSheet: (restaurantId: number) => void;
  closeRestaurantDetailSheet: () => void;

  addRateSheetState: { open: boolean; params: AddRateSheetParams | null };
  openAddRateSheet: (params?: AddRateSheetParams) => void;
  closeAddRateSheet: () => void;

  receiptSplitSheetState: { open: boolean; params: ReceiptSplitSheetParams | null };
  openReceiptSplitSheet: (params?: ReceiptSplitSheetParams) => void;
  closeReceiptSplitSheet: () => void;
};

const RestaurantsContext = createContext<RestaurantsContextValue | null>(null);

let _mmkv: MMKV | null = null;
function getMmkv(): MMKV | null {
  if (_mmkv) return _mmkv;
  try {
    _mmkv = new MMKV({ id: "tlm-restaurants-storage" });
    return _mmkv;
  } catch {
    return null;
  }
}

function readSyncJson<T>(key: string): T | null {
  try {
    const raw = getMmkv()?.getString(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  try {
    getMmkv()?.set(key, serialized);
  } catch {
    // Fall back to AsyncStorage below.
  }
  AsyncStorage.setItem(key, serialized).catch(() => {});
}

function removeKey(key: string): void {
  try {
    getMmkv()?.delete(key);
  } catch {
    // Ignore MMKV delete error.
  }
  AsyncStorage.removeItem(key).catch(() => {});
}

/**
 * Root data & sheet-navigation provider for the iPhone app.
 *
 * Hydrates `restaurants`, `cuisines`, `diners`, `recentReceipts`, and any
 * in-progress receipt split draft synchronously on cold start (`< 5 ms` via MMKV
 * with `AsyncStorage` fallback), then performs stale-while-revalidate background
 * sync directly against Supabase.
 *
 * Also coordinates the 3 global modal sheets (`RestaurantDetailSheet`,
 * `AddRateVisitSheet`, `ReceiptSplitSheet`) so any tab or card can trigger a
 * cross-flow handoff with pre-bound parameters.
 *
 * @param props - React children.
 * @returns `RestaurantsContext.Provider`.
 */
export function RestaurantsProvider({ children }: { children: React.ReactNode }) {
  const initialCache = useMemo(
    () =>
      readSyncJson<CatalogPayload & { syncedAt?: string }>(CATALOG_CACHE_KEY),
    [],
  );

  const [restaurants, setRestaurants] = useState<Restaurant[]>(
    () => initialCache?.restaurants ?? [],
  );
  const [cuisines, setCuisines] = useState<CuisineRow[]>(
    () => initialCache?.cuisines ?? [],
  );
  const [diners, setDiners] = useState<Diner[]>(
    () => initialCache?.diners ?? [],
  );
  const [recentReceipts, setRecentReceipts] = useState<MobileReceiptRow[]>(
    () => initialCache?.recentReceipts ?? [],
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => initialCache?.syncedAt ?? null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(() => !initialCache);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [detailMap, setDetailMap] = useState<Record<number, RestaurantDetailPayload>>({});

  // Active receipt split draft & offline photo queue
  const [activeReceiptDraft, setActiveReceiptDraftState] =
    useState<ReceiptWizardDraft | null>(() =>
      readSyncJson<ReceiptWizardDraft>(RECEIPT_DRAFT_STORAGE_KEY),
    );
  const [offlinePhotoQueue, setOfflinePhotoQueue] = useState<QueuedReceiptPhoto[]>(
    () => readSyncJson<QueuedReceiptPhoto[]>(OFFLINE_PHOTO_QUEUE_KEY) ?? [],
  );

  // Global Sheet states
  const [detailSheetState, setDetailSheetState] = useState<{
    open: boolean;
    restaurantId: number | null;
  }>({ open: false, restaurantId: null });

  const [addRateSheetState, setAddRateSheetState] = useState<{
    open: boolean;
    params: AddRateSheetParams | null;
  }>({ open: false, params: null });

  const [receiptSplitSheetState, setReceiptSplitSheetState] = useState<{
    open: boolean;
    params: ReceiptSplitSheetParams | null;
  }>({ open: false, params: null });

  // Async fallback hydration if MMKV wasn't available in simulator/web
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!initialCache) {
        try {
          const raw = await AsyncStorage.getItem(CATALOG_CACHE_KEY);
          if (raw && mounted) {
            const parsed = JSON.parse(raw) as CatalogPayload & { syncedAt?: string };
            setRestaurants(parsed.restaurants ?? []);
            setCuisines(parsed.cuisines ?? []);
            setDiners(parsed.diners ?? []);
            setRecentReceipts(parsed.recentReceipts ?? []);
            setLastSyncedAt(parsed.syncedAt ?? null);
            setIsLoading(false);
          }
        } catch {
          // Ignore AsyncStorage read error.
        }
      }
      if (!activeReceiptDraft) {
        try {
          const rawDraft = await AsyncStorage.getItem(RECEIPT_DRAFT_STORAGE_KEY);
          if (rawDraft && mounted) {
            setActiveReceiptDraftState(JSON.parse(rawDraft) as ReceiptWizardDraft);
          }
        } catch {
          // Ignore draft read error.
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [initialCache, activeReceiptDraft]);

  const refreshAll = useCallback(async () => {
    setIsSyncing(true);
    setError(null);
    try {
      const payload = await fetchCatalog(50);
      const syncedAt = new Date().toISOString();
      setRestaurants(payload.restaurants);
      setCuisines(payload.cuisines);
      setDiners(payload.diners);
      setRecentReceipts(payload.recentReceipts);
      setLastSyncedAt(syncedAt);
      writeJson(CATALOG_CACHE_KEY, { ...payload, syncedAt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to sync catalog.";
      setError(msg);
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    refreshAll().catch(() => {});
  }, [refreshAll]);

  const getCachedDetail = useCallback(
    (restaurantId: number): RestaurantDetailPayload | null => {
      if (detailMap[restaurantId]) return detailMap[restaurantId];
      return readSyncJson<RestaurantDetailPayload>(`${DETAIL_CACHE_PREFIX}${restaurantId}`);
    },
    [detailMap],
  );

  const fetchDetail = useCallback(
    async (
      restaurantId: number,
      forceRefresh: boolean = false,
    ): Promise<RestaurantDetailPayload> => {
      if (!forceRefresh) {
        const cached = getCachedDetail(restaurantId);
        if (cached) {
          // Trigger background refresh without blocking caller
          fetchRestaurantDetail(restaurantId)
            .then((fresh) => {
              setDetailMap((prev) => ({ ...prev, [restaurantId]: fresh }));
              writeJson(`${DETAIL_CACHE_PREFIX}${restaurantId}`, fresh);
            })
            .catch(() => {});
          return cached;
        }
      }
      const fresh = await fetchRestaurantDetail(restaurantId);
      setDetailMap((prev) => ({ ...prev, [restaurantId]: fresh }));
      writeJson(`${DETAIL_CACHE_PREFIX}${restaurantId}`, fresh);
      return fresh;
    },
    [getCachedDetail],
  );

  const setActiveReceiptDraft = useCallback((draft: ReceiptWizardDraft | null) => {
    setActiveReceiptDraftState(draft);
    if (!draft || (draft.items.length === 0 && draft.step === "upload" && draft.savedId === null)) {
      removeKey(RECEIPT_DRAFT_STORAGE_KEY);
    } else {
      writeJson(RECEIPT_DRAFT_STORAGE_KEY, {
        ...draft,
        updatedAt: new Date().toISOString(),
      });
    }
  }, []);

  const clearActiveReceiptDraft = useCallback(() => {
    setActiveReceiptDraftState(null);
    removeKey(RECEIPT_DRAFT_STORAGE_KEY);
  }, []);

  const enqueueOfflineReceiptPhoto = useCallback(
    (photo: Omit<QueuedReceiptPhoto, "id" | "createdAt">) => {
      const entry: QueuedReceiptPhoto = {
        ...photo,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      };
      setOfflinePhotoQueue((prev) => {
        const next = [entry, ...prev];
        writeJson(OFFLINE_PHOTO_QUEUE_KEY, next);
        return next;
      });
    },
    [],
  );

  const removeOfflineReceiptPhoto = useCallback((id: string) => {
    setOfflinePhotoQueue((prev) => {
      const next = prev.filter((p) => p.id !== id);
      writeJson(OFFLINE_PHOTO_QUEUE_KEY, next);
      return next;
    });
  }, []);

  const openRestaurantDetailSheet = useCallback((restaurantId: number) => {
    setDetailSheetState({ open: true, restaurantId });
  }, []);

  const closeRestaurantDetailSheet = useCallback(() => {
    setDetailSheetState({ open: false, restaurantId: null });
  }, []);

  const openAddRateSheet = useCallback((params?: AddRateSheetParams) => {
    setAddRateSheetState({ open: true, params: params ?? {} });
  }, []);

  const closeAddRateSheet = useCallback(() => {
    setAddRateSheetState({ open: false, params: null });
  }, []);

  const openReceiptSplitSheet = useCallback((params?: ReceiptSplitSheetParams) => {
    setReceiptSplitSheetState({ open: true, params: params ?? {} });
  }, []);

  const closeReceiptSplitSheet = useCallback(() => {
    setReceiptSplitSheetState({ open: false, params: null });
  }, []);

  const { rated: ratedRestaurants, wantToGo: wantToGoRestaurants } = useMemo(
    () => partitionRestaurants(restaurants),
    [restaurants],
  );

  const value = useMemo<RestaurantsContextValue>(
    () => ({
      restaurants,
      ratedRestaurants,
      wantToGoRestaurants,
      cuisines,
      diners,
      recentReceipts,
      isLoading,
      isSyncing,
      lastSyncedAt,
      error,
      refreshAll,
      fetchDetail,
      getCachedDetail,
      activeReceiptDraft,
      setActiveReceiptDraft,
      clearActiveReceiptDraft,
      offlinePhotoQueue,
      enqueueOfflineReceiptPhoto,
      removeOfflineReceiptPhoto,
      detailSheetState,
      openRestaurantDetailSheet,
      closeRestaurantDetailSheet,
      addRateSheetState,
      openAddRateSheet,
      closeAddRateSheet,
      receiptSplitSheetState,
      openReceiptSplitSheet,
      closeReceiptSplitSheet,
    }),
    [
      restaurants,
      ratedRestaurants,
      wantToGoRestaurants,
      cuisines,
      diners,
      recentReceipts,
      isLoading,
      isSyncing,
      lastSyncedAt,
      error,
      refreshAll,
      fetchDetail,
      getCachedDetail,
      activeReceiptDraft,
      setActiveReceiptDraft,
      clearActiveReceiptDraft,
      offlinePhotoQueue,
      enqueueOfflineReceiptPhoto,
      removeOfflineReceiptPhoto,
      detailSheetState,
      openRestaurantDetailSheet,
      closeRestaurantDetailSheet,
      addRateSheetState,
      openAddRateSheet,
      closeAddRateSheet,
      receiptSplitSheetState,
      openReceiptSplitSheet,
      closeReceiptSplitSheet,
    ],
  );

  return (
    <RestaurantsContext.Provider value={value}>
      {children}
    </RestaurantsContext.Provider>
  );
}

/**
 * Hook to access cached restaurant catalog data, receipt drafts, and global
 * modal sheet handoff actions.
 *
 * @returns `RestaurantsContextValue`.
 */
export function useRestaurants(): RestaurantsContextValue {
  const ctx = useContext(RestaurantsContext);
  if (!ctx) {
    throw new Error("useRestaurants must be used within a RestaurantsProvider");
  }
  return ctx;
}
