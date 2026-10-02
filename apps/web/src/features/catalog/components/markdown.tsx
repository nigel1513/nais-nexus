"use client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Allow only http, https, mailto and relative/fragment links; everything else (javascript:, data:, tel:, ...) is dropped. */
export function urlTransform(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (!scheme) return url.trim().startsWith("//") ? "" : url;
  return ["http", "https", "mailto"].includes(scheme[1].toLowerCase()) ? url : "";
}

const external = (href?: string) => !!href && /^https?:\/\//i.test(href);
const sub = "mt-5 mb-2 text-heading text-fg first:mt-0";
const components: Components = {
  h1: ({ children }) => <h3 className={sub}>{children}</h3>,
  h2: ({ children }) => <h4 className={sub}>{children}</h4>,
  h3: ({ children }) => <h5 className="mt-4 mb-1 text-body font-semibold text-fg">{children}</h5>,
  h4: ({ children }) => <h5 className="mt-4 mb-1 text-body font-semibold text-fg">{children}</h5>,
  h5: ({ children }) => <h5 className="mt-4 mb-1 text-body font-semibold text-fg">{children}</h5>,
  h6: ({ children }) => <h5 className="mt-4 mb-1 text-body font-semibold text-fg">{children}</h5>,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 marker:text-fg-muted">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 marker:text-fg-muted">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  code: ({ children }) => <code className="rounded-xs bg-bg-hover px-1 py-0.5 font-mono text-mono">{children}</code>,
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-md border border-border bg-bg-subtle p-3 [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-border pl-3 text-fg-muted">{children}</blockquote>,
  a: ({ href, children }) => (
    <a href={href} className="text-accent-fg underline underline-offset-4" {...(external(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="text-small [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">{children}</table>
    </div>
  ),
  img: () => null, // no remote images in descriptions (privacy, layout)
};

/**
 * Safe markdown: GFM, raw HTML skipped, urlTransform (http/https/mailto/relative only); headings demoted under the
 * page's single h1. Long-form type (15/26) capped at 72ch for comfortable reading.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="max-w-[72ch] break-words text-long text-fg">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={urlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
