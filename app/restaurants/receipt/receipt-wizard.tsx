"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Diner, ParsedReceipt, ShareableDinerLineItem, WizardItem } from "@/lib/receipts";
import { formatReceiptSplitText, splitReceipt } from "@/lib/receipts";
import LinkReceiptDialog from "@/components/link-receipt-dialog";

type Restaurant = { id: number; name: string; city: string };
type Step = "upload" | "review" | "diners" | "assign" | "tip" | "summary";

const DRAFT_STORAGE_KEY = "receipt-wizard-draft-v1";

type WizardDraft = {
  step: Step;
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
};

/**
 * Interactive 6-step receipt scanner and itemized bill-splitting wizard.
 * Persists in-progress state to localStorage so mobile camera reloads never
 * lose a parsed receipt, and keeps the split breakdown visible after saving
 * for easy copying/sharing.
 */
export default function ReceiptWizard({
  restaurants,
  isAdmin,
  googleMapsApiKey,
}: {
  restaurants: Restaurant[];
  isAdmin: boolean;
  googleMapsApiKey?: string;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [parseModel, setParseModel] = useState<string | null>(null);
  const [parsedMerchant, setParsedMerchant] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  const [restaurantId, setRestaurantId] = useState<number | null>(null);
  const [items, setItems] = useState<WizardItem[]>([]);
  const [subtotal, setSubtotal] = useState(0);
  const [tax, setTax] = useState(0);
  const [tip, setTip] = useState(0);
  const [tipFromReceipt, setTipFromReceipt] = useState(false);

  const [diners, setDiners] = useState<Diner[]>([]);
  const [selectedDinerIds, setSelectedDinerIds] = useState<number[]>([]);
  const [newDinerName, setNewDinerName] = useState("");

  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [expandedDiners, setExpandedDiners] = useState<Set<number>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "link-copied">("idle");

  // Restore any in-progress receipt draft on mount (protects against mobile browser reload).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as Partial<WizardDraft>;
        if (Array.isArray(draft.items) && draft.items.length > 0) {
          setItems(draft.items);
          if (draft.step) setStep(draft.step);
          if (draft.parseModel !== undefined) setParseModel(draft.parseModel);
          if (draft.parsedMerchant !== undefined) setParsedMerchant(draft.parsedMerchant);
          if (draft.restaurantId !== undefined) setRestaurantId(draft.restaurantId);
          if (typeof draft.subtotal === "number") setSubtotal(draft.subtotal);
          if (typeof draft.tax === "number") setTax(draft.tax);
          if (typeof draft.tip === "number") setTip(draft.tip);
          if (typeof draft.tipFromReceipt === "boolean") setTipFromReceipt(draft.tipFromReceipt);
          if (Array.isArray(draft.selectedDinerIds) && draft.selectedDinerIds.length > 0) {
            setSelectedDinerIds(draft.selectedDinerIds);
          }
          if (typeof draft.savedId === "number") setSavedId(draft.savedId);
        }
      }
    } catch {
      // Ignore storage read errors.
    } finally {
      setHydrated(true);
    }
  }, []);

  // Persist active draft to localStorage whenever wizard state changes.
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (items.length === 0 && step === "upload" && savedId === null) {
        window.localStorage.removeItem(DRAFT_STORAGE_KEY);
        return;
      }
      const draft: WizardDraft = {
        step,
        parseModel,
        parsedMerchant,
        restaurantId,
        items,
        subtotal,
        tax,
        tip,
        tipFromReceipt,
        selectedDinerIds,
        savedId,
      };
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Ignore quota/storage errors.
    }
  }, [
    hydrated,
    step,
    parseModel,
    parsedMerchant,
    restaurantId,
    items,
    subtotal,
    tax,
    tip,
    tipFromReceipt,
    selectedDinerIds,
    savedId,
  ]);

  useEffect(() => {
    fetch("/api/diners")
      .then((r) => r.json())
      .then((d) => {
        const list = (d.diners ?? []) as Diner[];
        setDiners(list);
        const self = list.find((x) => x.is_self);
        if (self) {
          setSelectedDinerIds((prev) =>
            prev.includes(self.id) ? prev : [self.id, ...prev],
          );
        }
      })
      .catch(() => {});
  }, []);

  function resetWizard() {
    setStep("upload");
    setParseModel(null);
    setParsedMerchant(null);
    setParseError(null);
    setRestaurantId(null);
    setItems([]);
    setSubtotal(0);
    setTax(0);
    setTip(0);
    setTipFromReceipt(false);
    setSavedId(null);
    setSaveError(null);
    setExpandedDiners(new Set());
    setCopyStatus("idle");
    const self = diners.find((x) => x.is_self);
    setSelectedDinerIds(self ? [self.id] : []);
    try {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  async function handleFile(file: File) {
    setParsing(true);
    setParseError(null);
    setSavedId(null);
    try {
      const base64 = await compressImage(file, 1200, 0.75);
      const resp = await fetch("/api/receipts/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_base64: base64, media_type: "image/jpeg" }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? "parse failed");
      const parsed = json.parsed as ParsedReceipt;
      setParseModel(json.model ?? null);
      setParsedMerchant(parsed.merchant ?? null);
      const wizardItems: WizardItem[] = parsed.items.map((it) => ({
        ...it,
        diner_ids: [],
      }));
      setItems(wizardItems);
      setSubtotal(parsed.subtotal ?? sumItems(wizardItems));
      setTax(parsed.tax ?? 0);
      if (parsed.tip != null) {
        setTip(parsed.tip);
        setTipFromReceipt(true);
      } else {
        setTip(0);
        setTipFromReceipt(false);
      }
      setStep("review");
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  const selectedDiners = useMemo(
    () => diners.filter((d) => selectedDinerIds.includes(d.id)),
    [diners, selectedDinerIds],
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
          name: it.name,
          share: round2((it.price * it.qty) / it.diner_ids.length),
          splitCount: it.diner_ids.length,
        }));
      map.set(p.diner_id, list);
    }
    return map;
  }, [items, split.per_diner]);

  const selectedRestaurantName = useMemo(
    () => restaurants.find((r) => r.id === restaurantId)?.name ?? parsedMerchant,
    [restaurants, restaurantId, parsedMerchant],
  );

  function buildShareText(receiptId: number | null = savedId): string {
    const shareUrl =
      receiptId != null && typeof window !== "undefined"
        ? `${window.location.origin}/restaurants/receipt/${receiptId}`
        : null;
    return formatReceiptSplitText({
      title: selectedRestaurantName,
      date: new Date().toISOString().slice(0, 10),
      perDiner: split.per_diner,
      dinerItems: dinerItemsMap,
      subtotal: split.subtotal,
      tax,
      tip,
      url: shareUrl,
    });
  }

  async function handleCopySplit() {
    const text = buildShareText(savedId);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      // Ignore clipboard failure
    }
  }

  async function handleShareLink() {
    const url =
      savedId != null && typeof window !== "undefined"
        ? `${window.location.origin}/restaurants/receipt/${savedId}`
        : null;
    const text = buildShareText(savedId);
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: selectedRestaurantName ? `${selectedRestaurantName} — Receipt Split` : "Receipt Split",
          text,
          ...(url ? { url } : {}),
        });
        return;
      } catch {
        // User cancelled or share failed; fall back to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(url ?? text);
      setCopyStatus(url ? "link-copied" : "copied");
      setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      // Ignore clipboard failure
    }
  }

  async function addDiner() {
    const name = newDinerName.trim();
    if (!name) return;
    const resp = await fetch("/api/diners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await resp.json();
    if (resp.ok && json.diner) {
      setDiners((d) => (d.some((x) => x.id === json.diner.id) ? d : [...d, json.diner]));
      setSelectedDinerIds((ids) => (ids.includes(json.diner.id) ? ids : [...ids, json.diner.id]));
      setNewDinerName("");
    }
  }

  function toggleDiner(id: number) {
    const self = diners.find((d) => d.is_self);
    if (self && self.id === id) return; // self is locked on
    setSelectedDinerIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  function toggleItemDiner(itemIdx: number, dinerId: number) {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== itemIdx) return it;
        const has = it.diner_ids.includes(dinerId);
        return {
          ...it,
          diner_ids: has ? it.diner_ids.filter((x) => x !== dinerId) : [...it.diner_ids, dinerId],
        };
      }),
    );
  }

  function assignAllToEveryone() {
    setItems((prev) => prev.map((it) => ({ ...it, diner_ids: [...selectedDinerIds] })));
  }

  function updateItem(idx: number, patch: Partial<WizardItem>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function addItem() {
    setItems((prev) => [...prev, { name: "", price: 0, qty: 1, diner_ids: [] }]);
  }

  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    if (savedId != null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const total = round2(split.subtotal + tax + tip);
      const resp = await fetch("/api/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          restaurant_id: restaurantId,
          visited_on: new Date().toISOString().slice(0, 10),
          subtotal: round2(split.subtotal),
          tax: round2(tax),
          tip: round2(tip),
          total,
          parse_model: parseModel,
          parsed_merchant: parsedMerchant,
          items: items
            .filter((it) => it.name.trim() && it.price > 0)
            .map((it) => ({
              name: it.name.trim(),
              price: it.price,
              qty: it.qty,
              diner_ids: it.diner_ids,
            })),
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? "save failed");
      setSavedId(json.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // === RENDER ===

  if (step === "upload") {
    return (
      <Card>
        <h2 className="text-lg font-semibold mb-2">1. Upload receipt</h2>
        <label className="block">
          <span className="text-sm text-stone-500">Snap or pick a photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
            disabled={parsing}
            className="mt-2 block w-full text-sm"
          />
        </label>
        {parsing && (
          <p className="mt-4 text-sm text-stone-500">Parsing receipt… (may take 10–20s)</p>
        )}
        {parseError && <p className="mt-4 text-sm text-red-600">{parseError}</p>}
        <div className="mt-6 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => {
              setSavedId(null);
              setItems([{ name: "", price: 0, qty: 1, diner_ids: [] }]);
              setStep("review");
            }}
            className="text-stone-500 underline hover:text-stone-800 dark:hover:text-stone-200"
          >
            Skip — enter items manually
          </button>
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => setStep(savedId ? "summary" : "review")}
              className="text-stone-700 dark:text-stone-300 font-medium underline"
            >
              Resume active receipt ({items.length} items) →
            </button>
          )}
        </div>
      </Card>
    );
  }

  if (step === "review") {
    return (
      <Card>
        <StepHeader n={2} title="Review items" onBack={() => setStep("upload")} onReset={resetWizard} />
        <p className="text-sm text-stone-500 mb-3">
          Edit anything the parser got wrong.
        </p>
        {isAdmin && (
          <RestaurantPicker
            restaurants={restaurants}
            value={restaurantId}
            onChange={setRestaurantId}
          />
        )}
        <table className="w-full text-sm mt-4">
          <thead>
            <tr className="text-left text-stone-500">
              <th className="font-normal py-1">Item</th>
              <th className="font-normal py-1 w-16">Qty</th>
              <th className="font-normal py-1 w-24">Price</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="border-t border-stone-200 dark:border-stone-800">
                <td className="py-1">
                  <input
                    value={it.name}
                    onChange={(e) => updateItem(i, { name: e.target.value })}
                    className="w-full bg-transparent px-1 py-0.5 border border-transparent focus:border-stone-300 dark:focus:border-stone-700 rounded"
                  />
                </td>
                <td className="py-1">
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={it.qty}
                    onChange={(e) => updateItem(i, { qty: Number(e.target.value) || 1 })}
                    className="w-full bg-transparent px-1 py-0.5 border border-transparent focus:border-stone-300 dark:focus:border-stone-700 rounded tabular-nums"
                  />
                </td>
                <td className="py-1">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={it.price}
                    onChange={(e) => updateItem(i, { price: Number(e.target.value) || 0 })}
                    className="w-full bg-transparent px-1 py-0.5 border border-transparent focus:border-stone-300 dark:focus:border-stone-700 rounded tabular-nums"
                  />
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    className="text-stone-400 hover:text-red-600"
                    aria-label="Remove item"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          onClick={addItem}
          className="mt-2 text-sm text-stone-500 hover:underline"
        >
          + Add item
        </button>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <label>
            <span className="text-stone-500">Subtotal</span>
            <input
              type="number"
              step="0.01"
              value={subtotal}
              onChange={(e) => setSubtotal(Number(e.target.value) || 0)}
              className="w-full mt-1 rounded border border-stone-300 dark:border-stone-700 bg-transparent px-2 py-1 tabular-nums"
            />
          </label>
          <label>
            <span className="text-stone-500">Tax</span>
            <input
              type="number"
              step="0.01"
              value={tax}
              onChange={(e) => setTax(Number(e.target.value) || 0)}
              className="w-full mt-1 rounded border border-stone-300 dark:border-stone-700 bg-transparent px-2 py-1 tabular-nums"
            />
          </label>
        </div>
        <NextBtn onClick={() => setStep("diners")} disabled={items.length === 0}>
          Next: who was there?
        </NextBtn>
      </Card>
    );
  }

  if (step === "diners") {
    return (
      <Card>
        <StepHeader n={3} title="Who was at the meal?" onBack={() => setStep("review")} onReset={resetWizard} />
        <p className="text-sm text-stone-500 mb-3">
          Tap names to select. Anush is always there.
        </p>
        <div className="flex flex-wrap gap-2">
          {diners.map((d) => {
            const on = selectedDinerIds.includes(d.id);
            const locked = d.is_self;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => toggleDiner(d.id)}
                disabled={locked}
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  on
                    ? "bg-stone-900 text-white border-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:border-stone-100"
                    : "bg-transparent text-stone-700 dark:text-stone-300 border-stone-300 dark:border-stone-700 hover:border-stone-500"
                } ${locked ? "opacity-90 cursor-default" : ""}`}
              >
                {d.name}
                {locked ? " ★" : ""}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex gap-2">
          <input
            value={newDinerName}
            onChange={(e) => setNewDinerName(e.target.value)}
            placeholder="Add a name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDiner();
              }
            }}
            className="flex-1 rounded border border-stone-300 dark:border-stone-700 bg-transparent px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={addDiner}
            className="px-3 py-1 text-sm rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Add
          </button>
        </div>
        <NextBtn
          onClick={() => setStep("assign")}
          disabled={selectedDinerIds.length === 0}
        >
          Next: assign items
        </NextBtn>
      </Card>
    );
  }

  if (step === "assign") {
    return (
      <Card>
        <StepHeader n={4} title="Who got what?" onBack={() => setStep("diners")} onReset={resetWizard} />
        <p className="text-sm text-stone-500 mb-2">
          Tap diners on each item. Multiple selections split that item evenly.
        </p>
        <button
          type="button"
          onClick={assignAllToEveryone}
          className="text-sm text-stone-500 underline mb-3"
        >
          Split everything evenly across all diners
        </button>
        <div className="space-y-3">
          {items.map((it, i) => (
            <div
              key={i}
              className="border border-stone-200 dark:border-stone-800 rounded p-3"
            >
              <div className="flex items-baseline justify-between mb-2">
                <span className="font-medium">{it.name || "(unnamed)"}</span>
                <span className="text-sm text-stone-500 tabular-nums">
                  ${(it.price * it.qty).toFixed(2)}
                  {it.qty > 1 && (
                    <span className="text-xs"> ({it.qty}×${it.price.toFixed(2)})</span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selectedDiners.map((d) => {
                  const on = it.diner_ids.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleItemDiner(i, d.id)}
                      className={`px-2.5 py-1 rounded-full text-xs border ${
                        on
                          ? "bg-stone-900 text-white border-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:border-stone-100"
                          : "bg-transparent text-stone-600 dark:text-stone-400 border-stone-300 dark:border-stone-700"
                      }`}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <NextBtn
          onClick={() => setStep("tip")}
          disabled={items.some((it) => it.diner_ids.length === 0)}
        >
          Next: tip
        </NextBtn>
        {items.some((it) => it.diner_ids.length === 0) && (
          <p className="text-xs text-stone-500 mt-2">
            Assign every item to at least one diner.
          </p>
        )}
      </Card>
    );
  }

  if (step === "tip") {
    return (
      <Card>
        <StepHeader n={5} title="Tip" onBack={() => setStep("assign")} onReset={resetWizard} />
        {tipFromReceipt ? (
          <p className="text-sm text-stone-500 mb-3">
            Tip detected on receipt: ${tip.toFixed(2)}. Adjust if needed.
          </p>
        ) : (
          <p className="text-sm text-stone-500 mb-3">
            No tip on the receipt — enter it here, or use a quick percentage.
          </p>
        )}
        <input
          type="number"
          step="0.01"
          min="0"
          value={tip}
          onChange={(e) => setTip(Number(e.target.value) || 0)}
          className="w-full rounded border border-stone-300 dark:border-stone-700 bg-transparent px-2 py-2 tabular-nums text-lg"
        />
        <div className="flex gap-2 mt-3">
          {[0.15, 0.18, 0.2, 0.22, 0.25].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setTip(round2(split.subtotal * p))}
              className="px-3 py-1 text-sm rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              {Math.round(p * 100)}%
            </button>
          ))}
        </div>
        <NextBtn onClick={() => setStep("summary")}>Next: who owes what</NextBtn>
      </Card>
    );
  }

  // Step 6: summary ("Who owes what") — kept visible before and after saving!
  const canLink = savedId != null && isAdmin && !restaurantId && Boolean(googleMapsApiKey);

  return (
    <Card>
      <StepHeader
        n={6}
        title="Who owes what"
        onBack={() => setStep("tip")}
        onReset={resetWizard}
      />
      {selectedRestaurantName && (
        <p className="text-xs text-stone-500 mb-2">
          Merchant: <span className="font-medium text-stone-700 dark:text-stone-300">{selectedRestaurantName}</span>
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="font-normal py-1">Diner</th>
            <th className="font-normal py-1 text-right">Items</th>
            <th className="font-normal py-1 text-right">+Tax</th>
            <th className="font-normal py-1 text-right">+Tip</th>
            <th className="font-normal py-1 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {split.per_diner.map((p) => {
            const isOpen = expandedDiners.has(p.diner_id);
            const dinerItems = dinerItemsMap.get(p.diner_id) ?? [];
            return (
              <Fragment key={p.diner_id}>
                <tr
                  className="border-t border-stone-200 dark:border-stone-800 cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50"
                  onClick={() =>
                    setExpandedDiners((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.diner_id)) next.delete(p.diner_id);
                      else next.add(p.diner_id);
                      return next;
                    })
                  }
                >
                  <td className="py-1.5 font-medium">
                    <span className="inline-block w-3 text-stone-400 tabular-nums">
                      {isOpen ? "▾" : "▸"}
                    </span>{" "}
                    {p.name}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">${p.items_total.toFixed(2)}</td>
                  <td className="py-1.5 text-right tabular-nums text-stone-500">${p.tax_share.toFixed(2)}</td>
                  <td className="py-1.5 text-right tabular-nums text-stone-500">${p.tip_share.toFixed(2)}</td>
                  <td className="py-1.5 text-right tabular-nums font-semibold">${p.total.toFixed(2)}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-stone-50 dark:bg-stone-800/30">
                    <td colSpan={5} className="py-2 px-3">
                      {dinerItems.length === 0 ? (
                        <p className="text-xs text-stone-500">No items assigned.</p>
                      ) : (
                        <ul className="text-xs space-y-1">
                          {dinerItems.map((it, i) => (
                            <li key={i} className="flex justify-between gap-3">
                              <span className="text-stone-700 dark:text-stone-300">
                                {it.name}
                                <span className="text-stone-500 ml-2">
                                  {it.splitCount === 1
                                    ? "(solo)"
                                    : `(split ${it.splitCount} ways)`}
                                </span>
                              </span>
                              <span className="tabular-nums text-stone-600 dark:text-stone-400">
                                ${it.share.toFixed(2)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-stone-300 dark:border-stone-700 text-stone-500">
            <td className="py-1.5">Total</td>
            <td className="py-1.5 text-right tabular-nums">${split.subtotal.toFixed(2)}</td>
            <td className="py-1.5 text-right tabular-nums">${tax.toFixed(2)}</td>
            <td className="py-1.5 text-right tabular-nums">${tip.toFixed(2)}</td>
            <td className="py-1.5 text-right tabular-nums font-semibold">
              ${(split.subtotal + tax + tip).toFixed(2)}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopySplit}
          className="flex-1 px-3 py-2 text-sm rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 font-medium"
        >
          {copyStatus === "copied" ? "Copied breakdown ✓" : "📋 Copy split for chat"}
        </button>
        <button
          type="button"
          onClick={handleShareLink}
          className="flex-1 px-3 py-2 text-sm rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 font-medium"
        >
          {copyStatus === "link-copied"
            ? "Copied link ✓"
            : savedId != null
              ? "🔗 Share receipt link"
              : "📤 Share breakdown"}
        </button>
      </div>

      {savedId == null ? (
        <>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="mt-3 w-full px-4 py-2 rounded bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save receipt & create share link"}
          </button>
          {saveError && <p className="text-sm text-red-600 mt-2">{saveError}</p>}
        </>
      ) : (
        <div className="mt-4 rounded-md border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              Saved ✓ — Receipt #{savedId}
            </p>
            <Link
              href={`/restaurants/receipt/${savedId}`}
              className="text-xs font-medium underline text-emerald-800 dark:text-emerald-300 hover:opacity-80"
            >
              Open shareable receipt page →
            </Link>
          </div>
          {canLink && (
            <div>
              <button
                type="button"
                onClick={() => setLinkDialogOpen(true)}
                className="w-full px-4 py-2 rounded bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 text-sm font-medium hover:opacity-90"
              >
                📍 Find on Google Maps
              </button>
              <p className="text-xs text-stone-500 mt-1.5">
                Link this receipt to a restaurant so you can rate it and see it in your history.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-xs text-stone-600 dark:text-stone-400 pt-1">
            {restaurantId && (
              <Link
                href={`/restaurant/${restaurantId}`}
                className="underline hover:text-stone-900 dark:hover:text-stone-100"
              >
                View restaurant →
              </Link>
            )}
            {isAdmin && (
              <Link href="/admin/receipts" className="underline hover:text-stone-900 dark:hover:text-stone-100">
                Receipt history →
              </Link>
            )}
            <button
              type="button"
              onClick={resetWizard}
              className="underline hover:text-stone-900 dark:hover:text-stone-100"
            >
              Split another receipt
            </button>
          </div>
          {canLink && (
            <LinkReceiptDialog
              receiptId={savedId}
              initialName={parsedMerchant ?? undefined}
              apiKey={googleMapsApiKey!}
              open={linkDialogOpen}
              onClose={() => setLinkDialogOpen(false)}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-800 p-5 bg-white dark:bg-stone-900">
      {children}
    </div>
  );
}

function StepHeader({
  n,
  title,
  onBack,
  onReset,
}: {
  n: number;
  title: string;
  onBack?: () => void;
  onReset?: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-lg font-semibold">
        <span className="text-stone-400 tabular-nums">{n}.</span> {title}
      </h2>
      <div className="flex items-center gap-3">
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:underline"
          >
            Start over
          </button>
        )}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-stone-500 hover:underline"
          >
            ← Back
          </button>
        )}
      </div>
    </div>
  );
}

function NextBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-5 w-full px-4 py-2 rounded bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 font-medium disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function RestaurantPicker({
  restaurants,
  value,
  onChange,
}: {
  restaurants: Restaurant[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-stone-500">Restaurant (optional)</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="mt-1 w-full rounded border border-stone-300 dark:border-stone-700 bg-transparent px-2 py-1"
      >
        <option value="">— none —</option>
        {restaurants.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.city})
          </option>
        ))}
      </select>
    </label>
  );
}

function compressImage(file: File, maxPx: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

function sumItems(items: WizardItem[]): number {
  return Math.round(items.reduce((s, it) => s + it.price * it.qty, 0) * 100) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
