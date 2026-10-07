import type { MetadataRoute } from "next";

/**
 * Generates the Web App Manifest (`/manifest.webmanifest`) so the site — and specifically
 * `/sf` — can be installed to an iPhone Home Screen as a standalone app.
 *
 * @returns Next.js Web App Manifest definition.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "What's Going On in SF · Anush Mattapalli",
    short_name: "SF Radar",
    description:
      "Live San Francisco food, nightlife, and outdoor events ranked by your taste signals.",
    start_url: "/sf",
    display: "standalone",
    background_color: "#0c0a09",
    theme_color: "#0c0a09",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
