// A light markdown reader for the note preview: an AST, never HTML, so a note can't inject anything into the page.

export type Inline =
  | { t: "text"; v: string } | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] } | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "quote"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "rule" }
  | { t: "list"; ordered: boolean; items: { done: boolean | null; c: Inline[] }[] };

const SAFE_LINK = /^(https?:|mailto:)/i;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  const push = (n: Inline, len: number) => { flush(); out.push(n); i += len; };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if (rest[0] === "\\" && /^\\[*_`[\]\\]/.test(rest)) { text += rest[1]; i += 2; continue; }
    if ((m = rest.match(/^`([^`\n]+)`/))) { push({ t: "code", v: m[1] }, m[0].length); continue; }
    if ((m = rest.match(/^\*\*(?=\S)(.+?)\*\*/))) { push({ t: "strong", c: parseInline(m[1]) }, m[0].length); continue; }
    if ((m = rest.match(/^\*(?=[^\s*])([^*\n]+?)\*/))) { push({ t: "em", c: parseInline(m[1]) }, m[0].length); continue; }
    if ((m = rest.match(/^_(?=[^\s_])([^_\n]+?)_(?![\p{L}\p{N}])/u)) && !/[\p{L}\p{N}]$/u.test(s.slice(0, i))) {
      push({ t: "em", c: parseInline(m[1]) }, m[0].length);
      continue;
    }
    if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      if (SAFE_LINK.test(m[2])) push({ t: "link", href: m[2], c: parseInline(m[1]) }, m[0].length);
      else { text += m[0]; i += m[0].length; } // A javascript: link stays visible text, not a link.
      continue;
    }
    if ((m = rest.match(/^https?:\/\/[^\s<>)\]]+/i)) && !/[\p{L}\p{N}]$/u.test(s.slice(0, i))) {
      const url = m[0].replace(/[.,;:!?'"]+$/, "");
      push({ t: "link", href: url, c: [{ t: "text", v: url }] }, url.length);
      continue;
    }
    text += rest[0];
    i += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) { blocks.push({ t: "para", c: parseInline(para.join("\n")) }); para = []; }
  };
  const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (/^```/.test(line)) {
      endPara();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ t: "code", v: code.join("\n") });
    } else if (!line.trim()) {
      endPara();
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      endPara();
      blocks.push({ t: "heading", level: m[1].length as 1 | 2 | 3, c: parseInline(m[2]) });
    } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      endPara();
      blocks.push({ t: "rule" });
    } else if (/^>\s?/.test(line)) {
      endPara();
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ""));
      i--;
      blocks.push({ t: "quote", c: parseInline(q.join("\n")) });
    } else if ((m = line.match(item))) {
      endPara();
      const ordered = m[2] !== undefined;
      const items: { done: boolean | null; c: Inline[] }[] = [];
      for (; i < lines.length; i++) {
        const li = lines[i].match(item);
        if (!li || (li[2] !== undefined) !== ordered) break;
        items.push({ done: li[3] === undefined ? null : li[3].toLowerCase() === "x", c: parseInline(li[4]) });
      }
      i--;
      blocks.push({ t: "list", ordered, items });
    } else {
      para.push(line);
    }
  }
  endPara();
  return blocks;
}

/** The note's text with the markup taken out, for one line in the list. */
export function plainLine(s: string): string {
  return s.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/[*_`]+/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}
