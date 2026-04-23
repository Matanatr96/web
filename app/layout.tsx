import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anush Mattapalli",
  description: "Software engineer, food enthusiast, and photographer based in NYC.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-stone-200 dark:border-stone-800">
          <div className="mx-auto max-w-6xl px-4 py-4 flex items-baseline justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Anush Mattapalli
            </Link>
            <nav className="text-sm text-stone-500">
              <Link
                href="/restaurants"
                className="hover:text-stone-900 dark:hover:text-stone-100"
              >
                All restaurants
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-stone-400">
          Built with Next.js + Supabase.
        </footer>
      </body>
    </html>
  );
}
