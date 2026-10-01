import { http } from "msw";
import { API, apiError } from "../http";
import { auditHandlers } from "./audit";
import { catalogHandlers } from "./catalog";
import { governanceHandlers } from "./governance";
import { identityHandlers } from "./identity";
import { notificationHandlers } from "./notifications";
import { projectHandlers } from "./projects";
import { readinessHandlers } from "./readiness";
import { storageHandlers } from "./storage";

/** Dev-only error injection: the client forwards ?mock_error=<CODE> from the page URL as X-Mock-Error (M10 §13). */
const errorInjection = http.all(`${API}/*`, ({ request }) => {
  const code = request.headers.get("x-mock-error");
  return code ? apiError(code, `Injected ${code}`) : undefined;
});

export const handlers = [
  errorInjection,
  ...identityHandlers,
  ...projectHandlers,
  ...catalogHandlers,
  ...governanceHandlers,
  ...readinessHandlers,
  ...auditHandlers,
  ...notificationHandlers,
  ...storageHandlers,
];
