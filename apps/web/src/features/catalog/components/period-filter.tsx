"use client";
import { Button, Input } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">{t("data.search.period.label")}</legend>
      <label className="flex flex-col gap-1 text-xs">
        {t("data.search.period.from")}
        <Input type="date" value={start} aria-invalid={showError} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("data.search.period.to")}
        <Input type="date" value={end} aria-invalid={showError} onChange={(e) => setEnd(e.target.value)} />
      </label>
      {showError ? (
        <p role="alert" className="text-xs text-danger">
          {t("validation.temporalRange")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={apply}>
          {t("data.search.period.apply")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onApply("", "")}>
          {t("data.search.period.clear")}
        </Button>
      </div>
    </fieldset>
  );
}
