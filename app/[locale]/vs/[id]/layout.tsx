/**
 * Server layout for the VS detail route — exists purely to own the share-card
 * metadata. The page itself is a client component and cannot export
 * generateMetadata.
 *
 * The OG image points at /api/share/[id], which renders the card. That route is
 * public and handles private claims by rendering a locked placeholder, so linking
 * it here cannot leak a private market (see lib/share-card.ts).
 *
 * The title and description are deliberately generic: this layout runs for every
 * claim including private ones, and reading the claim here to write a richer
 * description would put private claim text into HTML that any scraper can fetch.
 * The card route is the single place that decides what a stranger may see.
 */

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CARD_SIZES, shareCardPath } from "@/lib/share-card";

type VsLayoutProps = {
  params: Promise<{ locale: string; id: string }>;
  children: React.ReactNode;
};

export async function generateMetadata({ params }: VsLayoutProps): Promise<Metadata> {
  const { locale, id } = await params;
  const tMeta = await getTranslations({ locale, namespace: "metadata" });

  const claimId = Number(id);
  const siteLine = tMeta("title");
  const brand = siteLine.split("—")[0]?.trim() ?? "Mimir";
  const title = Number.isInteger(claimId) && claimId > 0 ? `Claim #${claimId} · ${brand}` : brand;
  const description = tMeta("description");

  // No card for a malformed id; better no image than a broken one in a preview.
  if (!Number.isInteger(claimId) || claimId < 1) {
    return { title, description };
  }

  const card = shareCardPath(claimId);
  const twitterCard = shareCardPath(claimId, "x");

  return {
    title,
    description,
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: card, width: CARD_SIZES.og.width, height: CARD_SIZES.og.height }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [twitterCard],
    },
    other: {
      // Farcaster reads its own image dimensions.
      "fc:frame:image": shareCardPath(claimId, "farcaster"),
    },
  };
}

export default function VsDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
