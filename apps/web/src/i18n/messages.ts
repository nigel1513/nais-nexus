import en from "@/messages/en.json";
import ko from "@/messages/ko.json";
import type { Locale } from "./locale";

export type Messages = typeof ko;
type Tree = { [key: string]: string | Tree };

export function lookup(tree: object, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function deepMerge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    out[k] = typeof v === "object" && typeof b === "object" ? deepMerge(b, v) : v;
  }
  return out;
}

/** Keys (dotted) present in `base` but missing in `other`. */
export function missingKeys(base: object, other: object, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    const o = (other as Record<string, unknown>)[k];
    if (typeof v === "string") {
      if (typeof o !== "string") out.push(prefix + k);
    } else if (typeof o !== "object" || o === null) {
      out.push(...missingKeys(v as object, {}, `${prefix}${k}.`));
    } else {
      out.push(...missingKeys(v as object, o as object, `${prefix}${k}.`));
    }
  }
  return out;
}

/** ko is the source of truth; en falls back to ko key by key (M10 §12). */
export function loadMessages(locale: Locale): Messages {
  if (locale === "ko") return ko;
  return deepMerge(ko as unknown as Tree, en as unknown as Tree) as unknown as Messages;
}
