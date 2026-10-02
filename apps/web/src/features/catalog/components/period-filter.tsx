"use client";
import { Button, cn, Input } from "@nais/ui";
import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { RailSection } from "./facet-panel";

/** Data-period overlap filter (temporal_from / temporal_to). Applies on button press so a half-typed range never hits the API. */
export function PeriodFilter({
  from,
  to,
  serverInvalid,
  onApply,
}: {
  from: string;
  to: string;
  serverInvalid: boolean;
  onApply: (from: string, to: string) => void;
}) {
  const t = useTranslations();
  const errorId = useId();
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [invalid, setInvalid] = useState(false);
  // Back/Forward and "reset" change the URL; re-derive the inputs.
  useEffect(() => {
    setStart(from);
    setEnd(to);
    setInvalid(false);
  }, [from, to]);

  const apply = () => {
    if (start && end && end < start) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onApply(start, end);
  };
  const showError = invalid || serverInvalid;
  const field = (short: string, label: string, value: string, set: (v: string) => void) => (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-2">
      <span aria-hidden="true" className="text-small text-fg-muted">
        {short}
      </span>
      <Input
        type="date"
        aria-label={label}
        value={value}
        aria-invalid={showError}
        aria-describedby={showError ? errorId : undefined}
        onChange={(e) => set(e.target.value)}
        // An empty native date field shows its format mask; mute it like a placeholder.
        className={cn("num text-small", !value && "[&::-webkit-datetime-edit]:text-fg-subtle")}
      />
    </div>
  );

  return (
    <RailSection title={t("data.search.period.label")}>
      <div className="flex flex-col gap-2">
        {field(t("data.search.period.fromShort"), t("data.search.period.from"), start, setStart)}
        {field(t("data.search.period.toShort"), t("data.search.period.to"), end, setEnd)}
        {showError ? (
          <p id={errorId} role="alert" className="flex items-start gap-1.5 text-small text-danger">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
            {t("validation.temporalRange")}
          </p>
        ) : null}
        <div className="flex gap-2 pl-10">
          <Button type="button" size="sm" onClick={apply}>
            {t("data.search.period.apply")}
          </Button>
          {from || to ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onApply("", "")}>
              {t("data.search.period.clear")}
            </Button>
          ) : null}
        </div>
      </div>
    </RailSection>
  );
}
