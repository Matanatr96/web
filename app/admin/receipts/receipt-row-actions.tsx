"use client";

import { useState } from "react";
import LinkReceiptDialog from "@/components/link-receipt-dialog";

type Props = {
  receiptId: number;
  parsedMerchant: string | null;
  apiKey: string;
};

/**
 * Per-row "Link" action on the receipt history page. Opens a Places picker
 * pre-seeded with the parsed merchant name.
 */
export default function ReceiptRowActions({ receiptId, parsedMerchant, apiKey }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs px-2.5 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300"
      >
        📍 Link to restaurant
      </button>
      <LinkReceiptDialog
        receiptId={receiptId}
        initialName={parsedMerchant ?? undefined}
        apiKey={apiKey}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
