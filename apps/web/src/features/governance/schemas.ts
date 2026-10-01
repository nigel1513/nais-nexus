import { z } from "zod";

export function accessRequestSchema(maxDays: number) {
  return z.object({
    project_id: z.string().min(1, "validation.projectRequired"),
    purpose: z.string().min(1, "validation.required"),
    purpose_detail: z.string().trim().min(20, "validation.purposeDetail").max(4000, "validation.purposeDetail"),
    requested_days: z
      .number({ error: "validation.requestedDays" })
      .int("validation.requestedDays")
      .min(1, "validation.requestedDays")
      .max(maxDays, "validation.requestedDays"),
  });
}

export type AccessRequestFormValues = z.infer<ReturnType<typeof accessRequestSchema>>;
