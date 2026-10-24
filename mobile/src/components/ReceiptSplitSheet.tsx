import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
  formatReceiptSplitText,
  round2,
  splitReceipt,
  type Diner,
  type ParsedReceipt,
  type ShareableDinerLineItem,
  type WizardItem,
} from "@web-lib/receipts";
import {
  DEFAULT_API_BASE_URL,
  autocompletePlaces,
  deleteDiner,
  linkReceiptToPlace,
  parseReceiptImage,
  saveReceiptSplit,
  upsertDiner,
  type AutocompletePlacePick,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import {
  useRestaurants,
  type ReceiptSplitSheetParams,
  type ReceiptWizardStep,
} from "@/store/RestaurantsContext";

export type ReceiptSplitSheetProps = {
  visible?: boolean;
  params?: ReceiptSplitSheetParams | null;
  onClose?: () => void;
};

type Stage = "capture" | "review" | "assign" | "summary";

const TIP_PRESETS = [0.15, 0.18, 0.2, 0.22, 0.25];

function sumItems(items: WizardItem[]): number {
  return round2(items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0));
}

function mapWizardStepToStage(step: ReceiptWizardStep): Stage {
  switch (step) {
    case "upload":
      return "capture";
    case "review":
    case "diners":
    case "tip":
      return "review";
    case "assign":
      return "assign";
    case "summary":
      return "summary";
  }
}

function mapStageToWizardStep(stage: Stage): ReceiptWizardStep {
  switch (stage) {
    case "capture":
      return "upload";
    case "review":
      return "review";
    case "assign":
      return "assign";
    case "summary":
      return "summary";
  }
}

/**
 * Global Sheet B: 4-Stage `< 25s` Native Receipt Scanner & Itemized Bill Splitter.
 *
 * - **Stage 1 (`capture`)**: Native camera / photo library capture with `1200px`
 *   JPEG `@ 0.75` compression (`expo-image-manipulator`), manual entry fallback,
 *   and automatic offline queue persistence (`enqueueOfflineReceiptPhoto`) when
 *   cellular/Wi-Fi drops.
 * - **Stage 2 (`review`)**: Overlapped latency UX — transitions immediately
 *   while `POST /api/receipts/parse` runs in the background so the user can tap
 *   active diners at the table (`Anush ★` locked on) and choose a tip preset
 *   (`15%..25%`). Once parsed, auto-matches `parsed.merchant` against cached
 *   restaurants, flags subtotal/confidence mismatches, and provides inline
 *   item/subtotal/tax/tip editing (`+ Add Item`, `+ Add 4% SF Mandate / Service Fee`).
 * - **Stage 3 (`assign`)**: Sticky diner pill bar (`GET /api/diners`, inline
 *   `+ Add Diner`, long-press/tap edit to rename in-place via `POST /api/diners`
 *   or delete via `DELETE /api/diners`), 1-tap `Split All Evenly`, per-item diner
 *   toggles, and `"🖌️ Active Diner Paintbrush"` mode for rapid 1-thumb assignment.
 * - **Stage 4 (`summary`)**: `splitReceipt` cent-reconciled breakdown with
 *   expandable per-diner items, `POST /api/receipts` persistence, 1-tap native
 *   iOS Share Sheet (`Share.share`) & clipboard copy (`formatReceiptSplitText` +
 *   universal permalink `https://www.thelastmattapalli.com/restaurants/receipt/[id]`),
 *   and 1-tap `📍 Link to [parsedMerchant] & Rate` (`POST /api/receipts/link` ->
 *   `openAddRateSheet`).
 *
 * @param props - Optional explicit visibility/params overrides (`ReceiptSplitSheetProps`).
 * @returns Modal element for the receipt split workflow.
 */
export default function ReceiptSplitSheet(props: ReceiptSplitSheetProps) {
  const { isAdmin, openAuthModal } = useAuth();
  const {
    restaurants,
    diners: contextDiners,
    recentReceipts,
    refreshAll,
    activeReceiptDraft,
    setActiveReceiptDraft,
    clearActiveReceiptDraft,
    enqueueOfflineReceiptPhoto,
    receiptSplitSheetState,
    closeReceiptSplitSheet,
    openAddRateSheet,
  } = useRestaurants();

  const visible = props.visible ?? receiptSplitSheetState.open;
  const activeParams = props.params ?? receiptSplitSheetState.params;
  const handleClose = props.onClose ?? closeReceiptSplitSheet;

  // Wizard core state
  const [stage, setStage] = useState<Stage>("capture");
  const [parsing, setParsing] = useState<boolean>(false);
  const [parseElapsedSec, setParseElapsedSec] = useState<number>(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseModel, setParseModel] = useState<string | null>(null);
  const [parsedMerchant, setParsedMerchant] = useState<string | null>(null);
  const [parsedSubtotal, setParsedSubtotal] = useState<number | null>(null);
  const [parsedConfidence, setParsedConfidence] = useState<number | null>(null);

  const [restaurantId, setRestaurantId] = useState<number | null>(null);
  const [showRestaurantPicker, setShowRestaurantPicker] = useState<boolean>(false);
  const [restaurantSearch, setRestaurantSearch] = useState<string>("");

  const [items, setItems] = useState<WizardItem[]>([]);
  const [subtotalInput, setSubtotalInput] = useState<string>("0.00");
  const [taxInput, setTaxInput] = useState<string>("0.00");
  const [tipInput, setTipInput] = useState<string>("0.00");
  const [tipFromReceipt, setTipFromReceipt] = useState<boolean>(false);
  const [pendingTipPreset, setPendingTipPreset] = useState<number | null>(0.2);

  // Diners state
  const [localDiners, setLocalDiners] = useState<Diner[]>([]);
  const [selectedDinerIds, setSelectedDinerIds] = useState<number[]>([]);
  const [newDinerName, setNewDinerName] = useState<string>("");
  const [isAddingDiner, setIsAddingDiner] = useState<boolean>(false);

  // Diner rename / delete modal state
  const [editingDiner, setEditingDiner] = useState<Diner | null>(null);
  const [renameDinerText, setRenameDinerText] = useState<string>("");
  const [isMutatingDiner, setIsMutatingDiner] = useState<boolean>(false);

  // Paintbrush assignment state
  const [paintbrushMode, setPaintbrushMode] = useState<boolean>(false);
  const [activeBrushDinerId, setActiveBrushDinerId] = useState<number | null>(null);

  // Summary, Save & Share state
  const [expandedDinerIds, setExpandedDinerIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState<boolean>(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "link-copied">("idle");

  // Post-save Google Places Linker state
  const [showPlacesLinker, setShowPlacesLinker] = useState<boolean>(false);
  const [placeQuery, setPlaceQuery] = useState<string>("");
  const [placeResults, setPlaceResults] = useState<AutocompletePlacePick[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<AutocompletePlacePick | null>(null);
  const [isSearchingPlaces, setIsSearchingPlaces] = useState<boolean>(false);
  const [isLinkingPlace, setIsLinkingPlace] = useState<boolean>(false);

  const hydratedFromOpenRef = useRef<boolean>(false);

  // Sync context diners into localDiners and lock `is_self` (Anush ★) on
  useEffect(() => {
    if (contextDiners.length > 0) {
      setLocalDiners(contextDiners);
      const selfDiner = contextDiners.find((d) => d.is_self);
      if (selfDiner) {
        setSelectedDinerIds((prev) =>
          prev.includes(selfDiner.id) ? prev : [selfDiner.id, ...prev],
        );
        setActiveBrushDinerId((prev) => prev ?? selfDiner.id);
      }
    }
  }, [contextDiners]);

  // Elapsed timer while Claude Haiku / Opus is parsing
  useEffect(() => {
    if (!parsing) {
      setParseElapsedSec(0);
      return;
    }
    const interval = setInterval(() => {
      setParseElapsedSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [parsing]);

  // Hydrate from `activeParams` or `activeReceiptDraft` when sheet opens
  useEffect(() => {
    if (!visible) {
      hydratedFromOpenRef.current = false;
      return;
    }
    if (hydratedFromOpenRef.current) return;
    hydratedFromOpenRef.current = true;

    const selfDiner = contextDiners.find((d) => d.is_self);
    const defaultDiners = selfDiner ? [selfDiner.id] : [];

    // Case 1: Re-opening a specific saved receipt ID from RestaurantDetailSheet or History
    if (activeParams?.receiptId) {
      const existing = recentReceipts.find((r) => r.id === activeParams.receiptId);
      if (existing) {
        const restoredItems: WizardItem[] = (existing.items ?? []).map((it) => ({
          name: it.name,
          price: Number(it.price),
          qty: Number(it.qty),
          diner_ids: (it.assignments ?? []).map((a) => a.diner_id),
        }));
        const usedIds = Array.from(
          new Set([
            ...defaultDiners,
            ...restoredItems.flatMap((i) => i.diner_ids),
          ]),
        );
        setItems(restoredItems);
        setRestaurantId(existing.restaurant_id ?? existing.restaurant?.id ?? null);
        setParsedMerchant(existing.parsed_merchant ?? existing.restaurant?.name ?? null);
        setParseModel(existing.parse_model ?? null);
        setSubtotalInput(Number(existing.subtotal).toFixed(2));
        setTaxInput(Number(existing.tax).toFixed(2));
        setTipInput(Number(existing.tip).toFixed(2));
        setTipFromReceipt(Number(existing.tip) > 0);
        setSelectedDinerIds(usedIds);
        setSavedId(existing.id);
        setStage("summary");
        return;
      }
    }

    // Case 2: Resuming active draft (or draft already exists and no conflicting new restaurantId)
    if (
      activeReceiptDraft &&
      (activeParams?.resumeDraft ||
        (activeReceiptDraft.items.length > 0 && !activeParams?.restaurantId))
    ) {
      setStage(mapWizardStepToStage(activeReceiptDraft.step));
      setParseModel(activeReceiptDraft.parseModel);
      setParsedMerchant(activeReceiptDraft.parsedMerchant);
      setRestaurantId(activeParams?.restaurantId ?? activeReceiptDraft.restaurantId);
      setItems(activeReceiptDraft.items);
      setSubtotalInput(activeReceiptDraft.subtotal.toFixed(2));
      setTaxInput(activeReceiptDraft.tax.toFixed(2));
      setTipInput(activeReceiptDraft.tip.toFixed(2));
      setTipFromReceipt(activeReceiptDraft.tipFromReceipt);
      setSelectedDinerIds(
        activeReceiptDraft.selectedDinerIds.length > 0
          ? activeReceiptDraft.selectedDinerIds
          : defaultDiners,
      );
      setSavedId(activeReceiptDraft.savedId);
      return;
    }

    // Case 3: Fresh scan (optionally pre-bound to `activeParams.restaurantId`)
    setStage("capture");
    setRestaurantId(activeParams?.restaurantId ?? null);
    setParsedMerchant(activeParams?.restaurantName ?? null);
    setParseError(null);
    setSaveError(null);
    setSavedId(null);
  }, [visible, activeParams, activeReceiptDraft, contextDiners, recentReceipts]);

  const tax = useMemo(() => round2( Math.max(0, Number(taxInput) || 0) ), [taxInput]);
  const tip = useMemo(() => round2( Math.max(0, Number(tipInput) || 0) ), [tipInput]);
  const subtotalNum = useMemo(
    () => round2(Math.max(0, Number(subtotalInput) || 0)),
    [subtotalInput],
  );

  // Persist draft to MMKV / AsyncStorage on every state change
  useEffect(() => {
    if (!visible) return;
    if (items.length === 0 && stage === "capture" && savedId === null) {
      return;
    }
    setActiveReceiptDraft({
      step: mapStageToWizardStep(stage),
      parseModel,
      parsedMerchant,
      restaurantId,
      items,
      subtotal: subtotalNum,
      tax,
      tip,
      tipFromReceipt,
      selectedDinerIds,
      savedId,
    });
  }, [
    visible,
    stage,
    parseModel,
    parsedMerchant,
    restaurantId,
    items,
    subtotalNum,
    tax,
    tip,
    tipFromReceipt,
    selectedDinerIds,
    savedId,
    setActiveReceiptDraft,
  ]);

  const selectedDiners = useMemo(
    () => localDiners.filter((d) => selectedDinerIds.includes(d.id)),
    [localDiners, selectedDinerIds],
  );

  const split = useMemo(
    () => splitReceipt(items, selectedDiners, tax, tip),
    [items, selectedDiners, tax, tip],
  );

  const dinerItemsMap = useMemo(() => {
    const map = new Map<number, ShareableDinerLineItem[]>();
    for (const p of split.per_diner) {
      const list = items
        .filter((it) => it.diner_ids.includes(p.diner_id) && it.name.trim() && it.price > 0)
        .map((it) => ({
          name: it.qty > 1 ? `${it.name} (${it.qty}×)` : it.name,
          share: round2((it.price * it.qty) / it.diner_ids.length),
          splitCount: it.diner_ids.length,
        }));
      map.set(p.diner_id, list);
    }
    return map;
  }, [items, split.per_diner]);

  const selectedRestaurant = useMemo(
    () => restaurants.find((r) => r.id === restaurantId) ?? null,
    [restaurants, restaurantId],
  );

  const displayTitle = useMemo(
    () => selectedRestaurant?.name ?? parsedMerchant ?? activeParams?.restaurantName ?? "Receipt Split",
    [selectedRestaurant, parsedMerchant, activeParams],
  );

  const itemsSum = useMemo(() => sumItems(items), [items]);

  const subtotalDiff = useMemo(() => {
    const refSub = parsedSubtotal ?? subtotalNum;
    if (!refSub || refSub <= 0) return 0;
    return round2(refSub - itemsSum);
  }, [parsedSubtotal, subtotalNum, itemsSum]);

  const validItems = useMemo(
    () => items.filter((it) => it.name.trim().length > 0 && it.price > 0),
    [items],
  );

  const unassignedValidItems = useMemo(
    () => validItems.filter((it) => it.diner_ids.length === 0),
    [validItems],
  );

  const unassignedAmount = useMemo(
    () => round2(unassignedValidItems.reduce((s, it) => s + it.price * it.qty, 0)),
    [unassignedValidItems],
  );

  const resetWizard = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const selfDiner = localDiners.find((d) => d.is_self);
    setStage("capture");
    setParsing(false);
    setParseError(null);
    setParseModel(null);
    setParsedMerchant(activeParams?.restaurantName ?? null);
    setParsedSubtotal(null);
    setParsedConfidence(null);
    setRestaurantId(activeParams?.restaurantId ?? null);
    setItems([]);
    setSubtotalInput("0.00");
    setTaxInput("0.00");
    setTipInput("0.00");
    setTipFromReceipt(false);
    setPendingTipPreset(0.2);
    setSelectedDinerIds(selfDiner ? [selfDiner.id] : []);
    setSavedId(null);
    setSaveError(null);
    setExpandedDinerIds(new Set());
    setCopyStatus("idle");
    setShowPlacesLinker(false);
    clearActiveReceiptDraft();
  }, [localDiners, activeParams, clearActiveReceiptDraft]);

  /**
   * Compress a captured/selected image to `<= 1200px` width at `0.75` JPEG
   * quality and immediately transition to Stage 2 (`review`) while calling
   * `POST /api/receipts/parse` in the background.
   */
  const processPickedAsset = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      setParsing(true);
      setParseError(null);
      setSavedId(null);
      // Immediately transition to Stage 2 so user can tap diners & tip preset while waiting!
      setStage("review");

      let compressedBase64: string | null = null;
      try {
        const targetWidth =
          asset.width && asset.height && asset.width > 1200 ? 1200 : asset.width || 1200;
        const manipulated = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: targetWidth } }],
          {
            compress: 0.75,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );
        compressedBase64 = manipulated.base64 ?? asset.base64 ?? null;
        if (!compressedBase64) {
          throw new Error("Could not encode receipt image as base64 JPEG.");
        }

        const { parsed, model }: { parsed: ParsedReceipt; model: string } =
          await parseReceiptImage(compressedBase64, "image/jpeg");

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setParseModel(model ?? null);
        setParsedMerchant(parsed.merchant ?? null);
        setParsedSubtotal(parsed.subtotal);
        setParsedConfidence(parsed.confidence);

        // Auto-match merchant against cached restaurants if not already bound
        if (!restaurantId && parsed.merchant) {
          const norm = parsed.merchant.trim().toLowerCase();
          const match = restaurants.find(
            (r) =>
              r.name.toLowerCase() === norm ||
              r.name.toLowerCase().includes(norm) ||
              norm.includes(r.name.toLowerCase()),
          );
          if (match) {
            setRestaurantId(match.id);
          }
        }

        const wizardItems: WizardItem[] = parsed.items.map((it) => ({
          ...it,
          diner_ids: [],
        }));
        setItems(wizardItems);

        const computedSub = sumItems(wizardItems);
        const sub = parsed.subtotal ?? computedSub;
        setSubtotalInput(sub.toFixed(2));
        setTaxInput((parsed.tax ?? 0).toFixed(2));

        if (parsed.tip != null) {
          setTipInput(parsed.tip.toFixed(2));
          setTipFromReceipt(true);
          setPendingTipPreset(null);
        } else if (pendingTipPreset != null) {
          setTipInput(round2(computedSub * pendingTipPreset).toFixed(2));
          setTipFromReceipt(false);
        } else {
          setTipInput("0.00");
          setTipFromReceipt(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to parse receipt.";
        setParseError(msg);
        if (compressedBase64) {
          enqueueOfflineReceiptPhoto({
            imageBase64: compressedBase64,
            mediaType: "image/jpeg",
            restaurantId,
          });
        }
        // Provide 1 blank row so the user isn't blocked if offline
        setItems((prev) =>
          prev.length > 0 ? prev : [{ name: "", price: 0, qty: 1, diner_ids: [] }],
        );
      } finally {
        setParsing(false);
      }
    },
    [restaurantId, restaurants, pendingTipPreset, enqueueOfflineReceiptPhoto],
  );

  const handleLaunchCamera = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Camera Access Required",
          "Enable camera permissions in Settings to scan receipts, or choose from your Photo Library.",
        );
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        quality: 0.85,
        base64: true,
      });
      if (!res.canceled && res.assets?.[0]) {
        await processPickedAsset(res.assets[0]);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Camera launch failed.");
    }
  }, [processPickedAsset]);

  const handleLaunchLibrary = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Photo Library Access Required",
          "Enable photo permissions in Settings to pick receipt screenshots.",
        );
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        quality: 0.85,
        base64: true,
      });
      if (!res.canceled && res.assets?.[0]) {
        await processPickedAsset(res.assets[0]);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Photo picker failed.");
    }
  }, [processPickedAsset]);

  // Diner toggles & inline CRUD
  const toggleDinerAtTable = useCallback(
    (dinerId: number) => {
      const self = localDiners.find((d) => d.is_self);
      if (self && self.id === dinerId) return; // Anush ★ is locked on
      Haptics.selectionAsync().catch(() => {});
      setSelectedDinerIds((prev) => {
        const exists = prev.includes(dinerId);
        const next = exists ? prev.filter((id) => id !== dinerId) : [...prev, dinerId];
        // Also strip deselected diner from item assignments
        if (exists) {
          setItems((currItems) =>
            currItems.map((it) => ({
              ...it,
              diner_ids: it.diner_ids.filter((id) => id !== dinerId),
            })),
          );
        }
        return next;
      });
    },
    [localDiners],
  );

  const handleAddDiner = useCallback(async () => {
    const trimmed = newDinerName.trim();
    if (!trimmed) return;
    if (!isAdmin) {
      openAuthModal();
      return;
    }
    setIsAddingDiner(true);
    try {
      const { diner } = await upsertDiner({ name: trimmed });
      setLocalDiners((prev) =>
        prev.some((d) => d.id === diner.id) ? prev : [...prev, diner],
      );
      setSelectedDinerIds((prev) =>
        prev.includes(diner.id) ? prev : [...prev, diner.id],
      );
      setActiveBrushDinerId(diner.id);
      setNewDinerName("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      refreshAll().catch(() => {});
    } catch (e) {
      Alert.alert("Could Not Add Diner", e instanceof Error ? e.message : "Failed to add diner");
    } finally {
      setIsAddingDiner(false);
    }
  }, [newDinerName, isAdmin, openAuthModal, refreshAll]);

  const handleRenameDiner = useCallback(async () => {
    if (!editingDiner) return;
    const trimmed = renameDinerText.trim();
    if (!trimmed) return;
    if (!isAdmin) {
      openAuthModal();
      return;
    }
    setIsMutatingDiner(true);
    try {
      const { diner } = await upsertDiner({ id: editingDiner.id, name: trimmed });
      setLocalDiners((prev) => prev.map((d) => (d.id === diner.id ? diner : d)));
      setEditingDiner(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      refreshAll().catch(() => {});
    } catch (e) {
      Alert.alert("Rename Failed", e instanceof Error ? e.message : "Failed to rename diner");
    } finally {
      setIsMutatingDiner(false);
    }
  }, [editingDiner, renameDinerText, isAdmin, openAuthModal, refreshAll]);

  const handleDeleteDiner = useCallback(async () => {
    if (!editingDiner || editingDiner.is_self) return;
    if (!isAdmin) {
      openAuthModal();
      return;
    }
    setIsMutatingDiner(true);
    try {
      await deleteDiner(editingDiner.id);
      const deletedId = editingDiner.id;
      setLocalDiners((prev) => prev.filter((d) => d.id !== deletedId));
      setSelectedDinerIds((prev) => prev.filter((id) => id !== deletedId));
      setItems((prev) =>
        prev.map((it) => ({
          ...it,
          diner_ids: it.diner_ids.filter((id) => id !== deletedId),
        })),
      );
      setEditingDiner(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      refreshAll().catch(() => {});
    } catch (e) {
      Alert.alert("Delete Failed", e instanceof Error ? e.message : "Failed to delete diner");
    } finally {
      setIsMutatingDiner(false);
    }
  }, [editingDiner, isAdmin, openAuthModal, refreshAll]);

  // Item CRUD & Diner Assignment Handlers
  const updateItem = useCallback((idx: number, patch: Partial<WizardItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }, []);

  const addItem = useCallback((defaultName: string = "", defaultPrice: number = 0) => {
    Haptics.selectionAsync().catch(() => {});
    setItems((prev) => [
      ...prev,
      { name: defaultName, price: defaultPrice, qty: 1, diner_ids: [...selectedDinerIds] },
    ]);
  }, [selectedDinerIds]);

  const removeItem = useCallback((idx: number) => {
    Haptics.selectionAsync().catch(() => {});
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const toggleItemDiner = useCallback((itemIdx: number, dinerId: number) => {
    Haptics.selectionAsync().catch(() => {});
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== itemIdx) return it;
        const has = it.diner_ids.includes(dinerId);
        return {
          ...it,
          diner_ids: has
            ? it.diner_ids.filter((x) => x !== dinerId)
            : [...it.diner_ids, dinerId],
        };
      }),
    );
  }, []);

  const assignAllToEveryone = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setItems((prev) => prev.map((it) => ({ ...it, diner_ids: [...selectedDinerIds] })));
  }, [selectedDinerIds]);

  const assignRemainingToEveryone = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setItems((prev) =>
      prev.map((it) =>
        it.diner_ids.length === 0 ? { ...it, diner_ids: [...selectedDinerIds] } : it,
      ),
    );
  }, [selectedDinerIds]);

  const clearAllAssignments = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setItems((prev) => prev.map((it) => ({ ...it, diner_ids: [] })));
  }, []);

  const applyTipPreset = useCallback(
    (pct: number) => {
      Haptics.selectionAsync().catch(() => {});
      setPendingTipPreset(pct);
      setTipFromReceipt(false);
      const base = itemsSum > 0 ? itemsSum : subtotalNum;
      setTipInput(round2(base * pct).toFixed(2));
    },
    [itemsSum, subtotalNum],
  );

  // Share & Save Helpers
  const getPermalinkUrl = useCallback(
    (receiptId: number | null = savedId): string | null => {
      if (receiptId == null) return null;
      return `${DEFAULT_API_BASE_URL.replace(/\/$/, "")}/restaurants/receipt/${receiptId}`;
    },
    [savedId],
  );

  const buildShareText = useCallback(
    (receiptId: number | null = savedId): string => {
      return formatReceiptSplitText({
        title: displayTitle,
        date: new Date().toISOString().slice(0, 10),
        perDiner: split.per_diner,
        dinerItems: dinerItemsMap,
        subtotal: split.subtotal,
        tax,
        tip,
        url: getPermalinkUrl(receiptId),
      });
    },
    [displayTitle, split, dinerItemsMap, tax, tip, savedId, getPermalinkUrl],
  );

  const handleCopySplit = useCallback(async () => {
    const text = buildShareText(savedId);
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopyStatus("copied");
    setTimeout(() => setCopyStatus("idle"), 2500);
  }, [buildShareText, savedId]);

  const handleNativeShare = useCallback(
    async (explicitId?: number | null) => {
      const targetId = explicitId !== undefined ? explicitId : savedId;
      const text = buildShareText(targetId);
      const url = getPermalinkUrl(targetId);
      try {
        await Share.share({
          title: `${displayTitle} — Receipt Split`,
          message: text,
          ...(url ? { url } : {}),
        });
      } catch {
        await Clipboard.setStringAsync(url ?? text);
        setCopyStatus(url ? "link-copied" : "copied");
        setTimeout(() => setCopyStatus("idle"), 2500);
      }
    },
    [buildShareText, getPermalinkUrl, savedId, displayTitle],
  );

  const handleSaveReceipt = useCallback(
    async (andShareAfter: boolean = false) => {
      if (savedId != null) {
        if (andShareAfter) await handleNativeShare(savedId);
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        const total = round2(split.subtotal + tax + tip);
        const res = await saveReceiptSplit({
          restaurant_id: restaurantId,
          visited_on: new Date().toISOString().slice(0, 10),
          subtotal: round2(split.subtotal),
          tax: round2(tax),
          tip: round2(tip),
          total,
          parse_model: parseModel,
          parsed_merchant: parsedMerchant,
          items: validItems.map((it) => ({
            name: it.name.trim(),
            price: Number(it.price),
            qty: Number(it.qty) || 1,
            diner_ids: it.diner_ids,
          })),
        });
        setSavedId(res.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        refreshAll().catch(() => {});
        if (andShareAfter) {
          await handleNativeShare(res.id);
        }
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Failed to save receipt split.");
      } finally {
        setSaving(false);
      }
    },
    [
      savedId,
      split.subtotal,
      tax,
      tip,
      restaurantId,
      parseModel,
      parsedMerchant,
      validItems,
      refreshAll,
      handleNativeShare,
    ],
  );

  // Post-save Google Places Linker & Handoff to AddRateVisitSheet
  const openPlacesLinker = useCallback(() => {
    if (!isAdmin) {
      openAuthModal();
      return;
    }
    const seed = parsedMerchant ?? "";
    setPlaceQuery(seed);
    setPlaceResults([]);
    setSelectedPlace(null);
    setShowPlacesLinker(true);
    if (seed.trim().length >= 2) {
      setIsSearchingPlaces(true);
      autocompletePlaces({ query: seed.trim() })
        .then((res) => {
          setPlaceResults(res);
          if (res.length > 0) setSelectedPlace(res[0]);
        })
        .catch(() => {})
        .finally(() => setIsSearchingPlaces(false));
    }
  }, [isAdmin, openAuthModal, parsedMerchant]);

  const searchPlacesForReceipt = useCallback(async () => {
    const q = placeQuery.trim();
    if (!q) return;
    setIsSearchingPlaces(true);
    try {
      const res = await autocompletePlaces({ query: q });
      setPlaceResults(res);
      if (res.length > 0) setSelectedPlace(res[0]);
    } catch (e) {
      Alert.alert("Places Search Failed", e instanceof Error ? e.message : "Error searching");
    } finally {
      setIsSearchingPlaces(false);
    }
  }, [placeQuery]);

  const confirmLinkToPlaceAndRate = useCallback(
    async (andRate: boolean) => {
      if (!savedId || !selectedPlace) return;
      setIsLinkingPlace(true);
      try {
        const res = await linkReceiptToPlace(savedId, {
          placeId: selectedPlace.placeId,
          name: selectedPlace.name,
          address: selectedPlace.address,
          city: selectedPlace.city,
          lat: selectedPlace.lat,
          lng: selectedPlace.lng,
          googleType: selectedPlace.googleType,
          googleTypeRaw: selectedPlace.googleTypeRaw,
        });
        setRestaurantId(res.restaurant_id);
        setShowPlacesLinker(false);
        await refreshAll();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

        if (andRate || res.is_new || !res.is_rated) {
          const currentSavedId = savedId;
          handleClose();
          openAddRateSheet({
            restaurantId: res.restaurant_id,
            attachReceiptId: currentSavedId,
            visitedOn: new Date().toISOString().slice(0, 10),
            initialMode: "rate",
          });
        }
      } catch (e) {
        Alert.alert("Link Failed", e instanceof Error ? e.message : "Could not link receipt");
      } finally {
        setIsLinkingPlace(false);
      }
    },
    [savedId, selectedPlace, refreshAll, handleClose, openAddRateSheet],
  );

  const filteredRestaurantsForPicker = useMemo(() => {
    const q = restaurantSearch.trim().toLowerCase();
    if (!q) return restaurants.slice(0, 25);
    return restaurants
      .filter(
        (r) =>
          r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q),
      )
      .slice(0, 25);
  }, [restaurants, restaurantSearch]);

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Top Sheet Bar */}
        <View style={styles.topHeader}>
          <View style={styles.topHeaderLeft}>
            <Text style={styles.sheetTitle}>Split a Receipt</Text>
            <Text style={styles.sheetSubtitle} numberOfLines={1}>
              {displayTitle}
              {split.subtotal > 0
                ? ` · $${round2(split.subtotal + tax + tip).toFixed(2)}`
                : ""}
            </Text>
          </View>
          <View style={styles.topHeaderActions}>
            {items.length > 0 || savedId !== null ? (
              <Pressable onPress={resetWizard} style={styles.resetBtn}>
                <Text style={styles.resetBtnText}>Start Over</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={handleClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>Done</Text>
            </Pressable>
          </View>
        </View>

        {/* Interactive 4-Stage Stepper Pills */}
        <View style={styles.stageTabsBar}>
          {(
            [
              { key: "capture", label: "1. Capture" },
              { key: "review", label: "2. Review & Tip" },
              { key: "assign", label: "3. Assign" },
              { key: "summary", label: "4. Share" },
            ] as { key: Stage; label: string }[]
          ).map((st) => {
            const active = stage === st.key;
            const disabled =
              st.key !== "capture" && items.length === 0 && !parsing && savedId === null;
            return (
              <Pressable
                key={st.key}
                disabled={disabled}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setStage(st.key);
                }}
                style={[
                  styles.stageTabPill,
                  active ? styles.stageTabPillActive : {},
                  disabled ? styles.disabledBtn : {},
                ]}
              >
                <Text
                  style={[
                    styles.stageTabText,
                    active ? styles.stageTabTextActive : {},
                  ]}
                >
                  {st.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* ===================== STAGE 1: CAPTURE ===================== */}
        {stage === "capture" ? (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>1. Snap or Pick Receipt Photo</Text>
              <Text style={styles.cardSub}>
                Automatically resizes to 1200px @ 0.75 JPEG and parses line items with Claude Haiku 4.5 (with automatic Opus 4.7 fallback on blurry or complex receipts).
              </Text>

              <Pressable style={styles.bigCameraCta} onPress={handleLaunchCamera}>
                <Text style={styles.bigCameraIcon}>📷</Text>
                <Text style={styles.bigCameraTitle}>Scan with Camera</Text>
                <Text style={styles.bigCameraSub}>
                  Position receipt flat on the table
                </Text>
              </Pressable>

              <View style={styles.captureRowBtns}>
                <Pressable style={styles.secondaryCaptureBtn} onPress={handleLaunchLibrary}>
                  <Text style={styles.secondaryCaptureBtnText}>🖼️ Photo Library</Text>
                </Pressable>

                <Pressable
                  style={styles.secondaryCaptureBtn}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setSavedId(null);
                    setItems([{ name: "", price: 0, qty: 1, diner_ids: [...selectedDinerIds] }]);
                    setStage("review");
                  }}
                >
                  <Text style={styles.secondaryCaptureBtnText}>✍️ Enter Manually</Text>
                </Pressable>
              </View>

              {parseError ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorBannerTitle}>Parse Error (Queued Offline)</Text>
                  <Text style={styles.errorBannerText}>{parseError}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        ) : null}

        {/* ===================== STAGE 2: OPTIMISTIC DINERS + REVIEW & TIP ===================== */}
        {stage === "review" ? (
          <ScrollView
            contentContainerStyle={styles.scrollBody}
            keyboardShouldPersistTaps="handled"
          >
            {/* Optimistic Claude Parsing Live Shimmer Banner */}
            {parsing ? (
              <View style={styles.parsingLiveCard}>
                <ActivityIndicator size="small" color="#10b981" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.parsingLiveTitle}>
                    {parseElapsedSec >= 5
                      ? "🔍 Verifying tricky lines with Claude Opus 4.7…"
                      : "✨ Reading receipt with Claude Haiku 4.5…"}
                  </Text>
                  <Text style={styles.parsingLiveSub}>
                    {parseElapsedSec}s elapsed — tap who&apos;s at the table &amp; your tip preset below while Claude finishes!
                  </Text>
                </View>
              </View>
            ) : null}

            {parseError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerTitle}>
                  Offline Queue Active — Photo Saved Locally
                </Text>
                <Text style={styles.errorBannerText}>
                  {parseError}. You can enter items manually below or retry from the Receipts tab once connected.
                </Text>
              </View>
            ) : null}

            {/* Optimistic Step A: Who's at the table? */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Who&apos;s at the table?</Text>
              <Text style={styles.cardSub}>
                Tap companions to include them in this split. Anush ★ is always included. Long-press any diner to rename or delete.
              </Text>

              <View style={styles.dinerChipsWrap}>
                {localDiners.map((d) => {
                  const on = selectedDinerIds.includes(d.id);
                  return (
                    <Pressable
                      key={d.id}
                      onPress={() => toggleDinerAtTable(d.id)}
                      onLongPress={() => {
                        setEditingDiner(d);
                        setRenameDinerText(d.name);
                      }}
                      style={[
                        styles.dinerPill,
                        on ? styles.dinerPillSelected : {},
                      ]}
                    >
                      <Text
                        style={[
                          styles.dinerPillText,
                          on ? styles.dinerPillTextSelected : {},
                        ]}
                      >
                        {d.name}
                        {d.is_self ? " ★" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.inlineAddRow}>
                <TextInput
                  style={styles.inlineInput}
                  value={newDinerName}
                  onChangeText={setNewDinerName}
                  placeholder="Add new diner name…"
                  placeholderTextColor="#78716c"
                  onSubmitEditing={handleAddDiner}
                  returnKeyType="done"
                />
                <Pressable
                  style={styles.inlineAddBtn}
                  onPress={handleAddDiner}
                  disabled={isAddingDiner || !newDinerName.trim()}
                >
                  <Text style={styles.inlineAddBtnText}>
                    {isAddingDiner ? "…" : "+ Add"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Restaurant / Merchant Picker */}
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Restaurant</Text>
                  <Text style={styles.cardSub}>
                    {selectedRestaurant
                      ? `Linked: ${selectedRestaurant.name} (${selectedRestaurant.city})`
                      : parsedMerchant
                        ? `Parsed merchant: "${parsedMerchant}" (unlinked)`
                        : "Optional — link now or after saving"}
                  </Text>
                </View>
                <Pressable
                  style={styles.smallOutlineBtn}
                  onPress={() => setShowRestaurantPicker((v) => !v)}
                >
                  <Text style={styles.smallOutlineBtnText}>
                    {showRestaurantPicker ? "Hide" : "Change"}
                  </Text>
                </Pressable>
              </View>

              {showRestaurantPicker ? (
                <View style={styles.pickerBox}>
                  <TextInput
                    style={styles.inlineInput}
                    value={restaurantSearch}
                    onChangeText={setRestaurantSearch}
                    placeholder="Filter saved restaurants…"
                    placeholderTextColor="#78716c"
                  />
                  <ScrollView style={{ maxHeight: 150 }}>
                    <Pressable
                      style={styles.pickerItem}
                      onPress={() => {
                        setRestaurantId(null);
                        setShowRestaurantPicker(false);
                      }}
                    >
                      <Text style={styles.pickerItemText}>— None (Orphan Receipt) —</Text>
                    </Pressable>
                    {filteredRestaurantsForPicker.map((r) => (
                      <Pressable
                        key={r.id}
                        style={styles.pickerItem}
                        onPress={() => {
                          setRestaurantId(r.id);
                          setShowRestaurantPicker(false);
                        }}
                      >
                        <Text
                          style={[
                            styles.pickerItemText,
                            restaurantId === r.id ? { color: "#10b981", fontWeight: "700" } : {},
                          ]}
                        >
                          {r.name} ({r.city})
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
            </View>

            {/* Confidence & Subtotal Mismatch Warning */}
            {!parsing &&
            items.length > 0 &&
            ((parsedConfidence !== null && parsedConfidence < 0.8) ||
              Math.abs(subtotalDiff) >= 0.02) ? (
              <View style={styles.warningBanner}>
                <Text style={styles.warningBannerTitle}>
                  ⚠️ Check Line Items
                  {parsedConfidence !== null
                    ? ` (Confidence ${(parsedConfidence * 100).toFixed(0)}%)`
                    : ""}
                </Text>
                <Text style={styles.warningBannerText}>
                  Items sum to ${itemsSum.toFixed(2)} vs receipt subtotal $
                  {(parsedSubtotal ?? subtotalNum).toFixed(2)}.
                </Text>
                {subtotalDiff > 0.01 ? (
                  <Pressable
                    style={styles.warningActionBtn}
                    onPress={() => addItem("Service Fee / Adjustment", subtotalDiff)}
                  >
                    <Text style={styles.warningActionBtnText}>
                      + Add ${subtotalDiff.toFixed(2)} Difference as Line Item
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Editable Line Items */}
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>
                  Line Items ({items.length})
                </Text>
                {parseModel ? (
                  <Text style={styles.modelBadgeText}>
                    {parseModel.includes("opus") ? "Opus 4.7" : "Haiku 4.5"}
                  </Text>
                ) : null}
              </View>

              {items.map((it, idx) => (
                <View key={idx} style={styles.editItemRow}>
                  <TextInput
                    style={[styles.editItemNameInput, { flex: 1 }]}
                    value={it.name}
                    onChangeText={(v) => updateItem(idx, { name: v })}
                    placeholder="Dish or drink name"
                    placeholderTextColor="#78716c"
                  />

                  <View style={styles.qtyStepper}>
                    <Pressable
                      style={styles.qtyBtn}
                      onPress={() =>
                        updateItem(idx, { qty: Math.max(1, (Number(it.qty) || 1) - 1) })
                      }
                    >
                      <Text style={styles.qtyBtnText}>−</Text>
                    </Pressable>
                    <Text style={styles.qtyValueText}>{it.qty}×</Text>
                    <Pressable
                      style={styles.qtyBtn}
                      onPress={() => updateItem(idx, { qty: (Number(it.qty) || 1) + 1 })}
                    >
                      <Text style={styles.qtyBtnText}>+</Text>
                    </Pressable>
                  </View>

                  <TextInput
                    style={styles.editItemPriceInput}
                    value={it.price === 0 ? "" : String(it.price)}
                    onChangeText={(v) => {
                      const cleaned = v.replace(/[^0-9.]/g, "");
                      updateItem(idx, { price: Number(cleaned) || 0 });
                    }}
                    placeholder="0.00"
                    placeholderTextColor="#78716c"
                    keyboardType="decimal-pad"
                  />

                  <Pressable
                    style={styles.removeItemBtn}
                    onPress={() => removeItem(idx)}
                  >
                    <Text style={styles.removeItemBtnText}>×</Text>
                  </Pressable>
                </View>
              ))}

              <View style={styles.addItemsBtnsRow}>
                <Pressable
                  style={styles.smallOutlineBtn}
                  onPress={() => addItem("", 0)}
                >
                  <Text style={styles.smallOutlineBtnText}>+ Add Item</Text>
                </Pressable>

                <Pressable
                  style={styles.smallOutlineBtn}
                  onPress={() =>
                    addItem("SF Mandate / Service Fee (4%)", round2(itemsSum * 0.04))
                  }
                >
                  <Text style={styles.smallOutlineBtnText}>+ Add 4% Fee</Text>
                </Pressable>
              </View>
            </View>

            {/* Subtotal, Tax & Tip Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Subtotal, Tax &amp; Tip</Text>
              <View style={styles.totalsGrid}>
                <View style={styles.totalFieldCol}>
                  <Text style={styles.fieldLabel}>Items Sum</Text>
                  <View style={styles.readonlyBox}>
                    <Text style={styles.readonlyBoxText}>${itemsSum.toFixed(2)}</Text>
                  </View>
                </View>

                <View style={styles.totalFieldCol}>
                  <Text style={styles.fieldLabel}>Tax ($)</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={taxInput}
                    onChangeText={setTaxInput}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#78716c"
                  />
                </View>

                <View style={styles.totalFieldCol}>
                  <Text style={styles.fieldLabel}>
                    Tip ($) {tipFromReceipt ? "• On Receipt" : ""}
                  </Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={tipInput}
                    onChangeText={(v) => {
                      setTipFromReceipt(false);
                      setPendingTipPreset(null);
                      setTipInput(v);
                    }}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#78716c"
                  />
                </View>
              </View>

              <View style={styles.tipPresetsRow}>
                {TIP_PRESETS.map((pct) => {
                  const expectedTip = round2((itemsSum > 0 ? itemsSum : subtotalNum) * pct);
                  const isSelected =
                    pendingTipPreset === pct ||
                    (Math.abs(tip - expectedTip) < 0.02 && expectedTip > 0);
                  return (
                    <Pressable
                      key={pct}
                      style={[
                        styles.tipPresetPill,
                        isSelected ? styles.tipPresetPillActive : {},
                      ]}
                      onPress={() => applyTipPreset(pct)}
                    >
                      <Text
                        style={[
                          styles.tipPresetText,
                          isSelected ? styles.tipPresetTextActive : {},
                        ]}
                      >
                        {Math.round(pct * 100)}%
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Pressable
                style={[
                  styles.primaryNextBtn,
                  validItems.length === 0 || selectedDinerIds.length === 0
                    ? styles.disabledBtn
                    : {},
                ]}
                disabled={validItems.length === 0 || selectedDinerIds.length === 0}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                  setStage("assign");
                }}
              >
                <Text style={styles.primaryNextBtnText}>
                  Next: Assign Items ({validItems.length}) →
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : null}

        {/* ===================== STAGE 3: TAP-TO-ASSIGN DINERS ===================== */}
        {stage === "assign" ? (
          <View style={{ flex: 1 }}>
            {/* Sticky Diner Bar + Paintbrush Mode Toggle */}
            <View style={styles.stickyAssignHeader}>
              <View style={styles.rowBetween}>
                <Text style={styles.stickyHeaderLabel}>
                  {paintbrushMode
                    ? "🖌️ Paintbrush Mode: Tap a diner below, then tap items"
                    : "Tap diners on each item (or long-press diner to edit)"}
                </Text>
                <Pressable
                  style={[
                    styles.paintbrushToggleBtn,
                    paintbrushMode ? styles.paintbrushToggleBtnActive : {},
                  ]}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setPaintbrushMode((v) => !v);
                    if (!activeBrushDinerId && selectedDiners[0]) {
                      setActiveBrushDinerId(selectedDiners[0].id);
                    }
                  }}
                >
                  <Text
                    style={[
                      styles.paintbrushToggleText,
                      paintbrushMode ? styles.paintbrushToggleTextActive : {},
                    ]}
                  >
                    🖌️ Paintbrush {paintbrushMode ? "ON" : "OFF"}
                  </Text>
                </Pressable>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.stickyDinerScroll}
              >
                {selectedDiners.map((d) => {
                  const isBrush = paintbrushMode && activeBrushDinerId === d.id;
                  return (
                    <Pressable
                      key={d.id}
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => {});
                        if (paintbrushMode) {
                          setActiveBrushDinerId(d.id);
                        } else {
                          setEditingDiner(d);
                          setRenameDinerText(d.name);
                        }
                      }}
                      onLongPress={() => {
                        setEditingDiner(d);
                        setRenameDinerText(d.name);
                      }}
                      style={[
                        styles.dinerPill,
                        styles.dinerPillSelected,
                        isBrush ? styles.dinerPillBrushActive : {},
                      ]}
                    >
                      <Text
                        style={[
                          styles.dinerPillTextSelected,
                          isBrush ? { color: "#064e3b", fontWeight: "800" } : {},
                        ]}
                      >
                        {isBrush ? "🖌️ " : ""}
                        {d.name}
                        {d.is_self ? " ★" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <View style={styles.quickBulkActionsRow}>
                <Pressable
                  style={styles.bulkActionChip}
                  onPress={assignAllToEveryone}
                >
                  <Text style={styles.bulkActionChipText}>
                    ⚡ Split All Evenly ({selectedDiners.length})
                  </Text>
                </Pressable>

                {unassignedValidItems.length > 0 ? (
                  <Pressable
                    style={styles.bulkActionChip}
                    onPress={assignRemainingToEveryone}
                  >
                    <Text style={styles.bulkActionChipText}>
                      Split {unassignedValidItems.length} Unassigned Evenly
                    </Text>
                  </Pressable>
                ) : null}

                <Pressable
                  style={styles.bulkActionChipMuted}
                  onPress={clearAllAssignments}
                >
                  <Text style={styles.bulkActionChipMutedText}>Clear</Text>
                </Pressable>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.scrollBody}>
              {items.map((it, idx) => {
                if (!it.name.trim() && it.price <= 0) return null;
                const lineTotal = round2(it.price * it.qty);
                const count = it.diner_ids.length;
                const perPerson = count > 0 ? round2(lineTotal / count) : null;

                return (
                  <Pressable
                    key={idx}
                    onPress={() => {
                      if (paintbrushMode && activeBrushDinerId != null) {
                        toggleItemDiner(idx, activeBrushDinerId);
                      }
                    }}
                    style={[
                      styles.assignItemCard,
                      count === 0 ? styles.assignItemCardUnassigned : {},
                    ]}
                  >
                    <View style={styles.assignItemHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.assignItemName}>
                          {it.name || "(Unnamed item)"}
                        </Text>
                        <Text style={styles.assignItemSub}>
                          {count === 0
                            ? "Tap diner below to assign"
                            : count === 1
                              ? `Solo · $${lineTotal.toFixed(2)}`
                              : `Split ${count} ways · $${perPerson?.toFixed(2)} each`}
                        </Text>
                      </View>
                      <Text style={styles.assignItemPrice}>
                        ${lineTotal.toFixed(2)}
                        {it.qty > 1 ? ` (${it.qty}×$${it.price.toFixed(2)})` : ""}
                      </Text>
                    </View>

                    <View style={styles.dinerChipsWrap}>
                      {selectedDiners.map((d) => {
                        const assigned = it.diner_ids.includes(d.id);
                        return (
                          <Pressable
                            key={d.id}
                            onPress={() => toggleItemDiner(idx, d.id)}
                            style={[
                              styles.itemDinerChip,
                              assigned ? styles.itemDinerChipOn : {},
                            ]}
                          >
                            <Text
                              style={[
                                styles.itemDinerChipText,
                                assigned ? styles.itemDinerChipTextOn : {},
                              ]}
                            >
                              {d.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Sticky Bottom Assignment Guardrail Bar */}
            <View style={styles.stickyBottomBar}>
              <View style={styles.rowBetween}>
                <Text style={styles.guardrailText}>
                  {unassignedValidItems.length === 0
                    ? `All ${validItems.length} items assigned ✓`
                    : `${unassignedValidItems.length} unassigned ($${unassignedAmount.toFixed(2)})`}
                </Text>
                <Text style={styles.guardrailTotalText}>
                  Total: ${round2(split.subtotal + tax + tip).toFixed(2)}
                </Text>
              </View>
              <Pressable
                style={[
                  styles.primaryNextBtn,
                  unassignedValidItems.length > 0 ? styles.disabledBtn : {},
                ]}
                disabled={unassignedValidItems.length > 0}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  setStage("summary");
                }}
              >
                <Text style={styles.primaryNextBtnText}>
                  Next: Who Owes What →
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* ===================== STAGE 4: SUMMARY, SAVE, LINK & SHARE ===================== */}
        {stage === "summary" ? (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Who Owes What</Text>
              <Text style={styles.cardSub}>
                Tap any person to expand their itemized dishes. Cent rounding drift is reconciled automatically on the largest payer.
              </Text>

              <View style={styles.summaryTableHeader}>
                <Text style={[styles.thCell, { flex: 1.5 }]}>Diner</Text>
                <Text style={styles.thCellRight}>Items</Text>
                <Text style={styles.thCellRight}>+Tax</Text>
                <Text style={styles.thCellRight}>+Tip</Text>
                <Text style={styles.thCellRight}>Total</Text>
              </View>

              {split.per_diner.map((p) => {
                const open = expandedDinerIds.has(p.diner_id);
                const dItems = dinerItemsMap.get(p.diner_id) ?? [];
                return (
                  <View key={p.diner_id} style={styles.summaryDinerBlock}>
                    <Pressable
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => {});
                        setExpandedDinerIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.diner_id)) next.delete(p.diner_id);
                          else next.add(p.diner_id);
                          return next;
                        });
                      }}
                      style={styles.summaryDinerRow}
                    >
                      <Text style={[styles.tdName, { flex: 1.5 }]}>
                        {open ? "▾ " : "▸ "}
                        {p.name}
                      </Text>
                      <Text style={styles.tdCell}>${p.items_total.toFixed(2)}</Text>
                      <Text style={styles.tdCellMuted}>${p.tax_share.toFixed(2)}</Text>
                      <Text style={styles.tdCellMuted}>${p.tip_share.toFixed(2)}</Text>
                      <Text style={styles.tdCellBold}>${p.total.toFixed(2)}</Text>
                    </Pressable>

                    {open ? (
                      <View style={styles.summarySubItemsBox}>
                        {dItems.length === 0 ? (
                          <Text style={styles.tdCellMuted}>No items assigned.</Text>
                        ) : (
                          dItems.map((it, i) => (
                            <View key={i} style={styles.summarySubItemRow}>
                              <Text style={styles.summarySubItemName}>
                                • {it.name}{" "}
                                <Text style={{ color: "#78716c" }}>
                                  {it.splitCount === 1
                                    ? "(solo)"
                                    : `(split ${it.splitCount} ways)`}
                                </Text>
                              </Text>
                              <Text style={styles.summarySubItemAmt}>
                                ${it.share.toFixed(2)}
                              </Text>
                            </View>
                          ))
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}

              <View style={styles.summaryTableFooter}>
                <Text style={[styles.tdName, { flex: 1.5 }]}>Total</Text>
                <Text style={styles.tdCell}>${split.subtotal.toFixed(2)}</Text>
                <Text style={styles.tdCellMuted}>${tax.toFixed(2)}</Text>
                <Text style={styles.tdCellMuted}>${tip.toFixed(2)}</Text>
                <Text style={styles.tdCellBold}>
                  ${round2(split.subtotal + tax + tip).toFixed(2)}
                </Text>
              </View>

              {/* Share & Copy Actions */}
              <View style={styles.shareButtonsRow}>
                <Pressable style={styles.copyBtn} onPress={handleCopySplit}>
                  <Text style={styles.copyBtnText}>
                    {copyStatus === "copied"
                      ? "Copied Breakdown ✓"
                      : "📋 Copy Split for Chat"}
                  </Text>
                </Pressable>

                <Pressable
                  style={styles.shareSheetBtn}
                  onPress={() => handleNativeShare()}
                >
                  <Text style={styles.shareSheetBtnText}>
                    {savedId != null ? "🔗 Share Receipt Link" : "📤 Share Breakdown"}
                  </Text>
                </Pressable>
              </View>

              {/* Save or Post-Save Permalink + Restaurant Linker */}
              {savedId == null ? (
                <View style={{ marginTop: 8, gap: 6 }}>
                  <Pressable
                    style={[styles.primarySaveBtn, saving ? styles.disabledBtn : {}]}
                    disabled={saving}
                    onPress={() => handleSaveReceipt(true)}
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color="#064e3b" />
                    ) : (
                      <Text style={styles.primarySaveBtnText}>
                        💾 Save Receipt &amp; Share Link
                      </Text>
                    )}
                  </Pressable>
                  {saveError ? (
                    <Text style={styles.errorBannerText}>{saveError}</Text>
                  ) : null}
                </View>
              ) : (
                <View style={styles.savedSuccessBox}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.savedTitle}>
                      Saved ✓ — Receipt #{savedId}
                    </Text>
                    <Pressable
                      onPress={() => {
                        const url = getPermalinkUrl(savedId);
                        if (url) Linking.openURL(url).catch(() => {});
                      }}
                    >
                      <Text style={styles.openWebLinkText}>
                        Open Web Permalink ↗
                      </Text>
                    </Pressable>
                  </View>

                  {!restaurantId ? (
                    <View style={styles.orphanPromptCol}>
                      <Pressable
                        style={styles.linkMapsBtn}
                        onPress={openPlacesLinker}
                      >
                        <Text style={styles.linkMapsBtnText}>
                          📍 Link to {parsedMerchant ? `"${parsedMerchant}"` : "Restaurant"} &amp; Rate
                        </Text>
                      </Pressable>

                      {showPlacesLinker ? (
                        <View style={styles.inlinePlacesBox}>
                          <View style={styles.inlineAddRow}>
                            <TextInput
                              style={styles.inlineInput}
                              value={placeQuery}
                              onChangeText={setPlaceQuery}
                              placeholder="Search Google Places…"
                              placeholderTextColor="#78716c"
                              onSubmitEditing={searchPlacesForReceipt}
                            />
                            <Pressable
                              style={styles.inlineAddBtn}
                              onPress={searchPlacesForReceipt}
                              disabled={isSearchingPlaces}
                            >
                              <Text style={styles.inlineAddBtnText}>
                                {isSearchingPlaces ? "…" : "Search"}
                              </Text>
                            </Pressable>
                          </View>

                          {placeResults.map((p) => {
                            const sel = selectedPlace?.placeId === p.placeId;
                            return (
                              <Pressable
                                key={p.placeId}
                                onPress={() => setSelectedPlace(p)}
                                style={[
                                  styles.placeOptionRow,
                                  sel ? styles.placeOptionRowSelected : {},
                                ]}
                              >
                                <View style={{ flex: 1 }}>
                                  <Text style={styles.placeOptionName}>{p.name}</Text>
                                  <Text style={styles.placeOptionAddr}>{p.address}</Text>
                                </View>
                                <Text style={{ color: "#10b981", fontWeight: "700" }}>
                                  {sel ? "●" : "○"}
                                </Text>
                              </Pressable>
                            );
                          })}

                          {selectedPlace ? (
                            <Pressable
                              style={[
                                styles.primarySaveBtn,
                                isLinkingPlace ? styles.disabledBtn : {},
                              ]}
                              disabled={isLinkingPlace}
                              onPress={() => confirmLinkToPlaceAndRate(true)}
                            >
                              <Text style={styles.primarySaveBtnText}>
                                {isLinkingPlace
                                  ? "Linking…"
                                  : `Confirm Link to ${selectedPlace.name} & Rate →`}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  ) : (
                    <Pressable
                      style={styles.rateLinkedBtn}
                      onPress={() => {
                        const targetRestId = restaurantId;
                        const currentSavedId = savedId;
                        handleClose();
                        openAddRateSheet({
                          restaurantId: targetRestId,
                          attachReceiptId: currentSavedId,
                          visitedOn: new Date().toISOString().slice(0, 10),
                          initialMode: "rate",
                        });
                      }}
                    >
                      <Text style={styles.rateLinkedBtnText}>
                        ⭐ Log Visit &amp; Rate {selectedRestaurant?.name ?? "Restaurant"} →
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </ScrollView>
        ) : null}

        {/* Diner Rename / Delete Context Modal */}
        <Modal
          visible={editingDiner !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setEditingDiner(null)}
        >
          <View style={styles.dinerModalBackdrop}>
            <View style={styles.dinerModalCard}>
              <Text style={styles.cardTitle}>
                Manage Diner: {editingDiner?.name}
              </Text>
              <Text style={styles.cardSub}>
                Renaming updates this diner across all historical receipt splits.
              </Text>
              <TextInput
                style={styles.fieldInput}
                value={renameDinerText}
                onChangeText={setRenameDinerText}
                placeholder="Diner name"
                placeholderTextColor="#78716c"
              />
              <View style={styles.dinerModalActions}>
                <Pressable
                  style={styles.primarySaveBtn}
                  onPress={handleRenameDiner}
                  disabled={isMutatingDiner}
                >
                  <Text style={styles.primarySaveBtnText}>Save Rename</Text>
                </Pressable>

                {editingDiner && !editingDiner.is_self ? (
                  <Pressable
                    style={styles.dangerDeleteBtn}
                    onPress={handleDeleteDiner}
                    disabled={isMutatingDiner}
                  >
                    <Text style={styles.dangerDeleteBtnText}>Delete Diner</Text>
                  </Pressable>
                ) : null}

                <Pressable
                  style={styles.smallOutlineBtn}
                  onPress={() => setEditingDiner(null)}
                >
                  <Text style={styles.smallOutlineBtnText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  topHeader: {
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: "#1c1917",
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  topHeaderLeft: {
    flex: 1,
  },
  sheetTitle: {
    color: "#fafaf9",
    fontSize: 18,
    fontWeight: "800",
  },
  sheetSubtitle: {
    color: "#a8a29e",
    fontSize: 12,
    marginTop: 2,
  },
  topHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resetBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#292524",
  },
  resetBtnText: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "600",
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  closeBtnText: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "700",
  },
  stageTabsBar: {
    flexDirection: "row",
    backgroundColor: "#141210",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
  },
  stageTabPill: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  stageTabPillActive: {
    backgroundColor: "#10b981",
    borderColor: "#10b981",
  },
  stageTabText: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "600",
  },
  stageTabTextActive: {
    color: "#064e3b",
    fontWeight: "800",
  },
  scrollBody: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  card: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 12,
  },
  cardTitle: {
    color: "#fafaf9",
    fontSize: 16,
    fontWeight: "700",
  },
  cardSub: {
    color: "#a8a29e",
    fontSize: 12,
    lineHeight: 17,
  },
  bigCameraCta: {
    backgroundColor: "#064e3b",
    borderWidth: 1.5,
    borderColor: "#10b981",
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 6,
  },
  bigCameraIcon: {
    fontSize: 34,
  },
  bigCameraTitle: {
    color: "#ecfdf5",
    fontSize: 18,
    fontWeight: "800",
  },
  bigCameraSub: {
    color: "#a7f3d0",
    fontSize: 12,
  },
  captureRowBtns: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryCaptureBtn: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryCaptureBtnText: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "600",
  },
  parsingLiveCard: {
    backgroundColor: "#064e3b",
    borderWidth: 1,
    borderColor: "#10b981",
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  parsingLiveTitle: {
    color: "#ecfdf5",
    fontSize: 14,
    fontWeight: "700",
  },
  parsingLiveSub: {
    color: "#a7f3d0",
    fontSize: 12,
    marginTop: 2,
  },
  errorBanner: {
    backgroundColor: "#450a0a",
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  errorBannerTitle: {
    color: "#fecaca",
    fontSize: 13,
    fontWeight: "700",
  },
  errorBannerText: {
    color: "#fca5a5",
    fontSize: 12,
  },
  warningBanner: {
    backgroundColor: "#451a03",
    borderWidth: 1,
    borderColor: "#d97706",
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  warningBannerTitle: {
    color: "#fef3c7",
    fontSize: 13,
    fontWeight: "700",
  },
  warningBannerText: {
    color: "#fde68a",
    fontSize: 12,
  },
  warningActionBtn: {
    backgroundColor: "#d97706",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  warningActionBtnText: {
    color: "#fafaf9",
    fontSize: 12,
    fontWeight: "700",
  },
  dinerChipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  dinerPill: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  dinerPillSelected: {
    backgroundColor: "#fafaf9",
    borderColor: "#fafaf9",
  },
  dinerPillBrushActive: {
    backgroundColor: "#10b981",
    borderColor: "#34d399",
  },
  dinerPillText: {
    color: "#d6d3d1",
    fontSize: 13,
    fontWeight: "600",
  },
  dinerPillTextSelected: {
    color: "#0c0a09",
    fontSize: 13,
    fontWeight: "700",
  },
  inlineAddRow: {
    flexDirection: "row",
    gap: 8,
  },
  inlineInput: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#fafaf9",
    fontSize: 13,
  },
  inlineAddBtn: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#57534e",
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineAddBtnText: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "700",
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  smallOutlineBtn: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  smallOutlineBtnText: {
    color: "#e7e5e4",
    fontSize: 12,
    fontWeight: "600",
  },
  pickerBox: {
    gap: 8,
    marginTop: 4,
  },
  pickerItem: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
  },
  pickerItemText: {
    color: "#d6d3d1",
    fontSize: 13,
  },
  modelBadgeText: {
    color: "#10b981",
    fontSize: 11,
    fontWeight: "700",
  },
  editItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 8,
  },
  editItemNameInput: {
    backgroundColor: "#292524",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#fafaf9",
    fontSize: 13,
  },
  qtyStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#292524",
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 4,
  },
  qtyBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  qtyBtnText: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "700",
  },
  qtyValueText: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "600",
  },
  editItemPriceInput: {
    width: 74,
    backgroundColor: "#292524",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    color: "#fafaf9",
    fontSize: 13,
    textAlign: "right",
  },
  removeItemBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  removeItemBtnText: {
    color: "#f87171",
    fontSize: 18,
    fontWeight: "700",
  },
  addItemsBtnsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  totalsGrid: {
    flexDirection: "row",
    gap: 8,
  },
  totalFieldCol: {
    flex: 1,
    gap: 4,
  },
  fieldLabel: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "600",
  },
  readonlyBox: {
    backgroundColor: "#141210",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  readonlyBoxText: {
    color: "#a8a29e",
    fontSize: 14,
    fontWeight: "700",
  },
  fieldInput: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: "#fafaf9",
    fontSize: 14,
  },
  tipPresetsRow: {
    flexDirection: "row",
    gap: 6,
  },
  tipPresetPill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    alignItems: "center",
  },
  tipPresetPillActive: {
    backgroundColor: "#10b981",
    borderColor: "#10b981",
  },
  tipPresetText: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "600",
  },
  tipPresetTextActive: {
    color: "#064e3b",
    fontWeight: "800",
  },
  primaryNextBtn: {
    backgroundColor: "#10b981",
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 4,
  },
  primaryNextBtnText: {
    color: "#064e3b",
    fontSize: 15,
    fontWeight: "800",
  },
  stickyAssignHeader: {
    backgroundColor: "#1c1917",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
    gap: 8,
  },
  stickyHeaderLabel: {
    color: "#a8a29e",
    fontSize: 12,
    flex: 1,
  },
  paintbrushToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  paintbrushToggleBtnActive: {
    backgroundColor: "#064e3b",
    borderColor: "#10b981",
  },
  paintbrushToggleText: {
    color: "#d6d3d1",
    fontSize: 11,
    fontWeight: "700",
  },
  paintbrushToggleTextActive: {
    color: "#34d399",
  },
  stickyDinerScroll: {
    flexDirection: "row",
    gap: 8,
  },
  quickBulkActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  bulkActionChip: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#57534e",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  bulkActionChipText: {
    color: "#fafaf9",
    fontSize: 11,
    fontWeight: "700",
  },
  bulkActionChipMuted: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  bulkActionChipMutedText: {
    color: "#78716c",
    fontSize: 11,
  },
  assignItemCard: {
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#292524",
    gap: 8,
  },
  assignItemCardUnassigned: {
    borderColor: "#d97706",
  },
  assignItemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  assignItemName: {
    color: "#fafaf9",
    fontSize: 15,
    fontWeight: "700",
  },
  assignItemSub: {
    color: "#a8a29e",
    fontSize: 11,
    marginTop: 2,
  },
  assignItemPrice: {
    color: "#10b981",
    fontSize: 14,
    fontWeight: "700",
  },
  itemDinerChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  itemDinerChipOn: {
    backgroundColor: "#10b981",
    borderColor: "#10b981",
  },
  itemDinerChipText: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "600",
  },
  itemDinerChipTextOn: {
    color: "#064e3b",
    fontWeight: "800",
  },
  stickyBottomBar: {
    backgroundColor: "#1c1917",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    gap: 8,
  },
  guardrailText: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "600",
  },
  guardrailTotalText: {
    color: "#10b981",
    fontSize: 13,
    fontWeight: "800",
  },
  summaryTableHeader: {
    flexDirection: "row",
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
  },
  thCell: {
    color: "#78716c",
    fontSize: 11,
    fontWeight: "600",
  },
  thCellRight: {
    flex: 1,
    color: "#78716c",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "right",
  },
  summaryDinerBlock: {
    borderBottomWidth: 1,
    borderBottomColor: "#262626",
    paddingVertical: 8,
    gap: 6,
  },
  summaryDinerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  tdName: {
    color: "#fafaf9",
    fontSize: 14,
    fontWeight: "700",
  },
  tdCell: {
    flex: 1,
    color: "#e7e5e4",
    fontSize: 13,
    textAlign: "right",
  },
  tdCellMuted: {
    flex: 1,
    color: "#a8a29e",
    fontSize: 12,
    textAlign: "right",
  },
  tdCellBold: {
    flex: 1,
    color: "#10b981",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "right",
  },
  summarySubItemsBox: {
    backgroundColor: "#141210",
    borderRadius: 8,
    padding: 8,
    gap: 4,
  },
  summarySubItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  summarySubItemName: {
    color: "#d6d3d1",
    fontSize: 12,
    flex: 1,
  },
  summarySubItemAmt: {
    color: "#a8a29e",
    fontSize: 12,
    fontWeight: "600",
  },
  summaryTableFooter: {
    flexDirection: "row",
    paddingTop: 8,
    borderTopWidth: 2,
    borderTopColor: "#44403c",
  },
  shareButtonsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  copyBtn: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  copyBtnText: {
    color: "#fafaf9",
    fontSize: 12,
    fontWeight: "700",
  },
  shareSheetBtn: {
    flex: 1,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#10b981",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  shareSheetBtnText: {
    color: "#34d399",
    fontSize: 12,
    fontWeight: "700",
  },
  primarySaveBtn: {
    backgroundColor: "#10b981",
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  primarySaveBtnText: {
    color: "#064e3b",
    fontSize: 14,
    fontWeight: "800",
  },
  savedSuccessBox: {
    backgroundColor: "#064e3b",
    borderWidth: 1,
    borderColor: "#10b981",
    borderRadius: 12,
    padding: 12,
    gap: 10,
    marginTop: 6,
  },
  savedTitle: {
    color: "#ecfdf5",
    fontSize: 14,
    fontWeight: "700",
  },
  openWebLinkText: {
    color: "#6ee7b7",
    fontSize: 12,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  orphanPromptCol: {
    gap: 8,
  },
  linkMapsBtn: {
    backgroundColor: "#fafaf9",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  linkMapsBtnText: {
    color: "#0c0a09",
    fontSize: 13,
    fontWeight: "800",
  },
  inlinePlacesBox: {
    backgroundColor: "#1c1917",
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  placeOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
    gap: 8,
  },
  placeOptionRowSelected: {
    borderColor: "#10b981",
    backgroundColor: "#064e3b",
  },
  placeOptionName: {
    color: "#fafaf9",
    fontSize: 13,
    fontWeight: "700",
  },
  placeOptionAddr: {
    color: "#a8a29e",
    fontSize: 11,
  },
  rateLinkedBtn: {
    backgroundColor: "#10b981",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  rateLinkedBtnText: {
    color: "#064e3b",
    fontSize: 13,
    fontWeight: "800",
  },
  dinerModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    padding: 24,
  },
  dinerModalCard: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#44403c",
    gap: 12,
  },
  dinerModalActions: {
    gap: 8,
  },
  dangerDeleteBtn: {
    backgroundColor: "#7f1d1d",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  dangerDeleteBtnText: {
    color: "#fecaca",
    fontSize: 13,
    fontWeight: "700",
  },
  disabledBtn: {
    opacity: 0.45,
  },
});
