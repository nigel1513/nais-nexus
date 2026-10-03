import { http } from "msw";
import { API, apiError } from "../http";
import { auditHandlers } from "./audit";
import { catalogHandlers } from "./catalog";
import { governanceHandlers } from "./governance";
import { hubHandlers } from "./hub";
import { identityHandlers } from "./identity";
import { noteHandlers } from "./notes";
import { notificationHandlers } from "./notifications";
import { previewHandlers } from "./previews";
import { projectHandlers } from "./projects";
import { readinessHandlers } from "./readiness";
import { storageHandlers } from "./storage";
import { workspaceHandlers } from "./workspace";

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
  ...previewHandlers,
  ...governanceHandlers,
  ...readinessHandlers,
  ...auditHandlers,
  ...notificationHandlers,
  ...storageHandlers,
  ...hubHandlers,
  ...workspaceHandlers,
  ...noteHandlers,
];
