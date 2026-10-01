import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IntlErrorCode, NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import ko from "@/messages/ko.json";
import { makeQueryClient } from "@/shared/api/query-client";
import { MOCK_USER_COOKIE } from "@/shared/config";
import { ToastProvider } from "@/shared/ui/toast";

export function setMockUser(userId: string | null) {
  document.cookie = userId ? `${MOCK_USER_COOKIE}=${userId}; path=/` : `${MOCK_USER_COOKIE}=; max-age=0; path=/`;
}

export function renderWithProviders(ui: ReactElement, { user }: { user?: string } = {}) {
  if (user) setMockUser(user);
  const queryClient = makeQueryClient({ retry: false });
  const result = render(
    <NextIntlClientProvider
      locale="ko"
      messages={ko}
      timeZone="Asia/Seoul"
      onError={(error) => {
        // A typo in a message key must fail the test, not silently render the key.
        if (error.code === IntlErrorCode.MISSING_MESSAGE) throw error;
      }}
    >
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { ...result, queryClient };
}
