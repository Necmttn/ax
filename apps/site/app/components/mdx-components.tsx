import type { ComponentProps } from "react";

// Plain semantic elements - all typography is owned by the `.prose` scope in
// globals.css (Tailwind utilities are dead here: they live in a cascade layer
// the unlayered design-system rules override). Keeping these as thin
// pass-throughs lets rehype-pretty-code's `pre`/`code` output flow through
// untouched while `.prose` handles spacing, color, and rhythm.
export const mdxComponents = {
  a: (props: ComponentProps<"a">) => {
    const external = typeof props.href === "string" && /^https?:/.test(props.href);
    return external ? (
      <a {...props} target="_blank" rel="noopener noreferrer" />
    ) : (
      <a {...props} />
    );
  },
};
