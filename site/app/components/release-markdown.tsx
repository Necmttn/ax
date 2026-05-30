export function MarkdownLite({ content }: { content: string }) {
  const blocks = content
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.startsWith("# ")) {
          return <h2 key={index}>{renderInline(block.slice(2))}</h2>;
        }
        if (block.startsWith("## ")) {
          return <h3 key={index}>{renderInline(block.slice(3))}</h3>;
        }
        if (block.startsWith("### ")) {
          return <h4 key={index}>{renderInline(block.slice(4))}</h4>;
        }
        if (block.split("\n").every((line) => line.trim().startsWith("* "))) {
          return (
            <ul key={index}>
              {block.split("\n").map((line, itemIndex) => (
                <li key={itemIndex}>{renderInline(line.trim().slice(2))}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInline(block.replace(/\n/g, " "))}</p>;
      })}
    </>
  );
}

function renderInline(text: string) {
  const parts: Array<
    | string
    | { kind: "link"; text: string; href: string }
    | { kind: "strong"; text: string }
  > = [];
  const inlinePattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      parts.push({ kind: "link", text: match[1], href: match[2] ?? "" });
    } else {
      parts.push({ kind: "strong", text: match[3] ?? "" });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return parts.map((part, index) => {
    if (typeof part === "string") return part;
    if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
    return <a key={index} href={part.href}>{part.text}</a>;
  });
}
