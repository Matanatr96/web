"use client";

export default function DeleteButton({ name }: { name: string }) {
  return (
    <button
      type="submit"
      onClick={(e) => {
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) {
          e.preventDefault();
        }
      }}
      className="text-sm text-red-600 hover:underline"
    >
      Delete
    </button>
  );
}
