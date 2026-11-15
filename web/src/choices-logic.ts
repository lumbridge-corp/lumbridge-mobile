// A blocked agent's menu line, made short enough for a button on a phone. No DOM, so it can be tested.
// The original words stay on the button for a screen reader and a hover, and pressChoice checks the original, never this.

// "(esc)", "(shift+tab)", "(ctrl+e)", "(y)": a key the program's own screen would take. Noise on glass, where the button is the key.
const HINT = /\s*\((?:esc|enter|return|tab|space|[a-z0-9]|(?:shift|ctrl|alt|cmd|meta|option|opt)\+[\w-]+)\)\s*$/i;

// The permission phrasings Claude Code and Codex use, word for word. Anything else keeps its own words.
const KNOWN: [RegExp, string][] = [
  [/^Yes, allow all edits during this session$/i, "Allow all edits this session"],
  [/^Yes, allow all edits in (.+?) during this session$/i, "Allow all edits in $1 this session"],
  [/^No, and tell (?:Claude|Codex|it) what to do differently$/i, "No, tell it what to do"],
  [/^No, and tell (?:Claude|Codex|it) what to do$/i, "No, tell it what to do"],
  [/^Yes, and don't ask again this session$/i, "Yes, don't ask again this session"],
  [/^Yes, and don't ask again (for .+)$/i, "Yes, don't ask again $1"],
  [/^Yes, and auto-accept edits$/i, "Yes, auto-accept edits"],
  [/^Yes, and manually approve edits$/i, "Yes, approve each edit"],
  [/^Yes, proceed$/i, "Yes"],
  [/^Yes, just this once$/i, "Yes, this once"],
];

export function shortLabel(label: string): string {
  let s = label.trim();
  for (let i = 0; i < 3 && HINT.test(s); i++) s = s.replace(HINT, "");
  for (const [re, to] of KNOWN) if (re.test(s)) { s = s.replace(re, to); break; }
  return s || label.trim();
}

/** How the buttons sit: side by side, each as wide as its words (one line, so a card stays short), or stacked when there are
 *  four or more, or the words together are too long to share a line without becoming cramped columns. */
export function choiceFit(labels: string[]): "row" | "stack" {
  const chars = labels.reduce((n, l) => n + l.length, 0);
  return labels.length >= 4 || chars > 64 ? "stack" : "row";
}
