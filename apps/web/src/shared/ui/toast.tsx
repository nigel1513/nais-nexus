/**
 * App toasts are the Sonner wrapper from @nais/ui (one <Toaster> in app/providers.tsx):
 * `notify.success(msg)` leaves after 4s; `notify.error(msg)` stays until closed and is announced assertively.
 */
export { notify } from "@nais/ui";
