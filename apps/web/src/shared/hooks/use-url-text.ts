"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text input mirrored to a URL query param after a debounce. The URL is the source of truth: when it changes
 * for another reason (Back/Forward) the input follows, without echoing the change back into history.
 */
export function useUrlText(
  param: string,
  params: URLSearchParams,
  setParams: (patch: Record<string, string | null>) => void,
  delay = 300,
): [text: string, onChange: (value: string) => void, committed: string] {
  const committed = params.get(param) ?? "";
  const [text, setText] = useState(committed);
  const seen = useRef(committed);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setParamsRef = useRef(setParams);
  const committedRef = useRef(committed);
  useEffect(() => {
    setParamsRef.current = setParams;
    committedRef.current = committed;
  });

  useEffect(() => {
    if (committed === seen.current) return;
    seen.current = committed;
    clearTimeout(timer.current);
    setText(committed);
  }, [committed]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const next = value.trim();
        seen.current = next;
        if (next !== committedRef.current) setParamsRef.current({ [param]: next || null });
      }, delay);
    },
    [delay, param],
  );
  return [text, onChange, committed];
}
