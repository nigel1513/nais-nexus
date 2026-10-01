import { notFound } from "next/navigation";

/**
 * /commons/_ui — every @nais/ui primitive in every state, light and dark side by side. Mock mode only.
 * The env comparison is written out (not isMocking()) so the bundler folds it and real-mode builds drop the gallery.
 */
export default async function UiGalleryPage() {
  if (process.env.NEXT_PUBLIC_API_MOCKING === "enabled") {
    const { UiGallery } = await import("@/features/ui-gallery/ui-gallery");
    return <UiGallery />;
  }
  notFound();
}
