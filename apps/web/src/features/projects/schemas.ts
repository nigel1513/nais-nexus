import { z } from "zod";
import type { Project, Schemas } from "@/shared/api/types";

export const splitKeywords = (s: string) =>
  s
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

export const projectFormSchema = z
  .object({
    name: z.string().trim().min(2, "validation.projectName").max(200, "validation.projectName"),
    description: z.string().max(10000, "validation.projectDescription"),
    visibility: z.enum(["PRIVATE", "PUBLIC"]),
    keywords: z.string(),
    start_date: z.string(),
    end_date: z.string(),
  })
  .superRefine((v, ctx) => {
    const kws = splitKeywords(v.keywords);
    if (kws.length > 20 || kws.some((k) => k.length > 50)) ctx.addIssue({ code: "custom", path: ["keywords"], message: "validation.keywordsMax" });
    if (v.start_date && v.end_date && v.end_date < v.start_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "validation.endBeforeStart" });
  });

export type ProjectFormValues = z.infer<typeof projectFormSchema>;

export const emptyProjectForm: ProjectFormValues = { name: "", description: "", visibility: "PRIVATE", keywords: "", start_date: "", end_date: "" };

export function toProjectCreate(v: ProjectFormValues): Schemas["ProjectCreate"] {
  return {
    name: v.name.trim(),
    description: v.description,
    visibility: v.visibility,
    keywords: splitKeywords(v.keywords),
    ...(v.start_date ? { start_date: v.start_date } : {}),
    ...(v.end_date ? { end_date: v.end_date } : {}),
  };
}

export function toProjectUpdate(v: ProjectFormValues): Schemas["ProjectUpdate"] {
  return {
    name: v.name.trim(),
    description: v.description,
    visibility: v.visibility,
    keywords: splitKeywords(v.keywords),
    start_date: v.start_date || null,
    end_date: v.end_date || null,
  };
}

export function fromProject(p: Project): ProjectFormValues {
  return {
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    keywords: (p.keywords ?? []).join(", "),
    start_date: p.start_date ?? "",
    end_date: p.end_date ?? "",
  };
}
