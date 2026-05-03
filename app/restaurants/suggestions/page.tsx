import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import SuggestionsQuiz from "@/components/suggestions-quiz";

export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  const { data, error } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });

  if (error) {
    return (
      <div className="text-red-600">
        Failed to load restaurants: {error.message}
      </div>
    );
  }

  const restaurants = (data ?? []) as Restaurant[];

  return (
    <div className="max-w-3xl mx-auto">
      <nav className="text-sm text-stone-500 mb-4 flex gap-3">
        <Link href="/restaurants" className="hover:underline">← Restaurants</Link>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Suggestions</h1>
        <p className="text-sm text-stone-500 mt-1">
          Answer a few quick questions and I&apos;ll suggest places I&apos;ve loved.
        </p>
      </div>
      <SuggestionsQuiz restaurants={restaurants} />
    </div>
  );
}
