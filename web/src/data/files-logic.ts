// Files, the parts with no browser in them: how a file reads in the grid and the sheet.

export const CATEGORIES = ["vehicle", "document", "receipt", "person", "place", "home", "work", "screenshot", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const LABELS: Record<Category, string> = {
  vehicle: "Vehicles", document: "Documents", receipt: "Receipts", person: "People", place: "Places",
  home: "Home", work: "Work", screenshot: "Screenshots", other: "Other",
};
const ONE: Record<Category, string> = {
  vehicle: "Vehicle", document: "Document", receipt: "Receipt", person: "Person", place: "Place",
  home: "Home", work: "Work", screenshot: "Screenshot", other: "Other",
};

export const categoryLabel = (c: string | null, plural = false): string =>
  c && (CATEGORIES as readonly string[]).includes(c) ? (plural ? LABELS : ONE)[c as Category] : "Not filed yet";

export interface Captioned {
  name: string;
  description: string | null;
  status: "new" | "filed" | "failed";
  sensitive: boolean;
  category: string | null;
}

/** A short line under a thumbnail. A private file shows its category only, so a glance over the owner's shoulder learns nothing. */
export function caption(f: Captioned, max = 80): string {
  if (f.sensitive) return `Private ${categoryLabel(f.category).toLowerCase()}`;
  const text = (f.status === "filed" && f.description?.trim()) || f.name || "Untitled";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** What the server's refusal means to the owner. */
export function refusalText(code: string | null | undefined): string {
  switch (code) {
    case "too_large": return "Too big: 50 MB at most";
    case "empty_file": return "This file is empty";
    case "missing": return "This device lost the file before it was sent";
    default: return "The server wouldn't take this";
  }
}

const KIND: Record<string, string> = { vin: "VIN", plate: "Plate", serial: "Serial", account: "Account", phone: "Phone", other: "Number" };
export const kindLabel = (k: string) => KIND[k] ?? "Number";

/** Browsers other than Safari can't draw HEIC, so a waiting one shows a plain tile until the server has made its preview. */
export const drawable = (mime: string) => /^image\/(jpeg|png|gif|webp)$/.test(mime) || (mime === "image/heic" && /iP(hone|ad)|Macintosh/.test(navigator.userAgent));

/** Whether the server has a thumbnail to give. It falls back to the original for what every browser can draw; anything else
 *  has one only once the server has filed it, and only images and PDFs get one. A plain text file never does, so asking is a 404. */
export function hasThumb(f: { mime: string; status: "new" | "filed" | "failed" }): boolean {
  if (/^image\/(jpeg|png|gif|webp)$/.test(f.mime)) return true;
  return f.status === "filed" && (f.mime.startsWith("image/") || f.mime === "application/pdf");
}

/** The mark on a tile with no picture: its extension, as "PDF" or "TXT", or "FILE" when the name has none worth showing. */
export function typeMark(name: string, mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const m = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
  return m ? m[1].toUpperCase() : "FILE";
}

/** A name for a photo taken here, as the camera gives every one "image.jpg". */
export function photoName(now: Date, n: number, mime: string): string {
  const pad = (x: number) => String(x).padStart(2, "0");
  const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
  return `Photo ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}${n > 1 ? ` (${n})` : ""}.${ext}`;
}
