import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, currentUser, fail, newestFirst, paginate } from "../http";
import type { StoredNotification } from "../types";

function view(n: StoredNotification): Schemas["Notification"] {
  return { notification_id: n.notification_id, type: n.type, title: n.title, body: n.body, link: n.link, read: n.read, created_at: n.created_at };
}

export const notificationHandlers = [
  http.get(`${API}/notifications`, ({ request }) => {
    const user = currentUser(request);
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get("unread_only") === "true";
    const mine = getDb().notifications.filter((n) => n.user_id === user.user_id);
    const items = mine
      .filter((n) => !unreadOnly || !n.read)
      .sort(newestFirst("created_at"))
      .map(view);
    return HttpResponse.json({ ...paginate(items, url), unread_count: mine.filter((n) => !n.read).length });
  }),

  http.post(`${API}/notifications/read-all`, ({ request }) => {
    const user = currentUser(request);
    for (const n of getDb().notifications) if (n.user_id === user.user_id) n.read = true;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API}/notifications/:notification_id/read`, ({ request, params }) => {
    const user = currentUser(request);
    const n = getDb().notifications.find((x) => x.notification_id === params.notification_id && x.user_id === user.user_id);
    if (!n) fail("NOTIFICATION_NOT_FOUND");
    n.read = true;
    return HttpResponse.json(view(n));
  }),
];
