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
const components: Components = {
  h1: ({ children }) => <h3 className="mt-4 text-lg font-semibold">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 font-semibold">{children}</h5>,
  h4: ({ children }) => <h5 className="mt-2 font-semibold">{children}</h5>,
  h5: ({ children }) => <h5 className="mt-2 font-semibold">{children}</h5>,
  h6: ({ children }) => <h5 className="mt-2 font-semibold">{children}</h5>,
  a: ({ href, children }) => (
    <a href={href} className="underline underline-offset-4" {...(external(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-sm">{children}</table>
    </div>
  ),
  img: () => null, // no remote images in descriptions (privacy, layout)
};

/** Safe markdown: GFM, raw HTML skipped, urlTransform (http/https/mailto/relative only); headings demoted under the page's single h1. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={urlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
