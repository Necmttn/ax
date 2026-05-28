import type { ComponentProps } from "react";

export const mdxComponents = {
  h1: (props: ComponentProps<"h1">) => <h1 className="text-3xl font-semibold mt-12 mb-4" {...props} />,
  h2: (props: ComponentProps<"h2">) => <h2 className="text-2xl font-semibold mt-10 mb-3" {...props} />,
  h3: (props: ComponentProps<"h3">) => <h3 className="text-xl font-semibold mt-8 mb-2" {...props} />,
  p: (props: ComponentProps<"p">) => <p className="leading-7 my-4" {...props} />,
  ul: (props: ComponentProps<"ul">) => <ul className="my-4 ml-6 list-disc" {...props} />,
  ol: (props: ComponentProps<"ol">) => <ol className="my-4 ml-6 list-decimal" {...props} />,
  li: (props: ComponentProps<"li">) => <li className="my-1 leading-7" {...props} />,
  code: (props: ComponentProps<"code">) => <code className="font-mono text-sm bg-black/5 px-1 py-0.5 rounded" {...props} />,
  pre: (props: ComponentProps<"pre">) => <pre className="my-4 p-4 rounded-lg overflow-x-auto bg-black/90 text-white text-sm" {...props} />,
  a: (props: ComponentProps<"a">) => <a className="underline decoration-1 underline-offset-2" {...props} />,
  blockquote: (props: ComponentProps<"blockquote">) => <blockquote className="my-4 pl-4 border-l-4 border-black/15 italic" {...props} />,
};
