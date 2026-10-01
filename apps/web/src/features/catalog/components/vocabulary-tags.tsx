"use client";
import { Badge } from "@nais/ui";
import type { VocabularyScheme } from "@/shared/api/types";
import { useVocabularyLabels } from "../api";

export function VocabularyTags({ scheme, codes }: { scheme: VocabularyScheme; codes: string[] }) {
  const label = useVocabularyLabels();
  if (!codes.length) return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {codes.map((code) => (
        <li key={code}>
          <Badge tone="neutral">{label(scheme, code)}</Badge>
        </li>
      ))}
    </ul>
  );
}
