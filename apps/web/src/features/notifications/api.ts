"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/api/client";
import type { NotificationPage } from "@/shared/api/types";

export function useListNotifications(query: { unread_only?: boolean; limit?: number } = {}, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["listNotifications", query],
    queryFn: async () => (await unwrap(api.GET("/notifications", { params: { query } }))) as NotificationPage,
    // M10 §7.13: 30s polling, paused while the window is hidden (refetchIntervalInBackground=false).
    refetchInterval: poll ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => unwrap(api.POST("/notifications/{notification_id}/read", { params: { path: { notification_id: notificationId } } })),
    onSettled: () => qc.invalidateQueries({ queryKey: ["listNotifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/notifications/read-all")),
    onSettled: () => qc.invalidateQueries({ queryKey: ["listNotifications"] }),
  });
}
