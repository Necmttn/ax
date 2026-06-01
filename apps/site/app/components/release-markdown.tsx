export function MarkdownLite({ content }: { content: string }) {
  const blocks = parseBlocks(content.replace(/^---[\s\S]*?---\s*/, ""));

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre key={index} className="release-code">
              <code>{block.value}</code>
            </pre>
          );
        }
        const image = parseImage(block.value);
        if (image) {
          return (
            <figure key={index} className="release-figure">
              <img src={image.src} alt={image.alt} />
              {image.alt ? <figcaption>{image.alt}</figcaption> : null}
            </figure>
          );
        }
        const { value } = block;
        if (value.startsWith("# ")) {
          return <h2 key={index}>{renderInline(value.slice(2))}</h2>;
        }
        if (value.startsWith("## ")) {
          return <h3 key={index}>{renderInline(value.slice(3))}</h3>;
        }
        if (value.startsWith("### ")) {
          return <h4 key={index}>{renderInline(value.slice(4))}</h4>;
        }
        if (value.split("\n").every((line) => line.trim().startsWith("* "))) {
          return (
            <ul key={index}>
              {value.split("\n").map((line, itemIndex) => (
                <li key={itemIndex}>{renderInline(line.trim().slice(2))}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInline(value.replace(/\n/g, " "))}</p>;
      })}
    </>
  );
}

export function MarkdownInline({ text }: { text: string }) {
  return <>{renderInline(text)}</>;
}

type Block = { kind: "text" | "code"; value: string };

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const textBuffer: string[] = [];
  let codeBuffer: string[] | null = null;

  const flushText = () => {
    const value = textBuffer.join("\n").trim();
    if (value) {
      blocks.push({ kind: "text", value });
    }
    textBuffer.length = 0;
  };

  for (const line of content.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (codeBuffer) {
        blocks.push({ kind: "code", value: codeBuffer.join("\n").replace(/\n$/, "") });
        codeBuffer = null;
      } else {
        flushText();
        codeBuffer = [];
      }
      continue;
    }

    if (codeBuffer) {
      codeBuffer.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushText();
    } else {
      textBuffer.push(line);
    }
  }

  if (codeBuffer) {
    blocks.push({ kind: "code", value: codeBuffer.join("\n").replace(/\n$/, "") });
  }
  flushText();

  return blocks;
}

function parseImage(text: string): { alt: string; src: string } | null {
  const match = text.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!match) return null;
  return { alt: match[1] ?? "", src: match[2] ?? "" };
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
