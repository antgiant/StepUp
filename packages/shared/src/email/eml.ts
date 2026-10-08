/** A saved email (.eml), read just enough to get the receipt out of it. Pure: the caller supplies the file's bytes as text (latin1). */
export interface EmlAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface EmlMessage {
  headers: Record<string, string>;
  /** Readable text: the plain-text part, or the HTML part with tags stripped. */
  text: string;
  attachments: EmlAttachment[];
}

const decoder = (charset: string | undefined): TextDecoder => {
  try {
    return new TextDecoder(charset?.toLowerCase() ?? "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
};

const toBytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function splitHeadBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const param = (header: string | undefined, name: string): string | undefined => {
  const m = new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header ?? "");
  return m ? (m[1] ?? m[2]) : undefined;
};

/** "=?UTF-8?B?...?=" / "=?utf-8?Q?...?=" words in a header. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, enc: string, data: string) => {
    const bytes = enc.toLowerCase() === "b" ? toBytes(atob(data)) : toBytes(qpDecode(data.replace(/_/g, " ")));
    return decoder(charset).decode(bytes);
  });
}

function qpDecode(s: string): string {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBody(body: string, encoding: string | undefined): Uint8Array {
  switch (encoding?.toLowerCase()) {
    case "base64":
      return toBytes(atob(body.replace(/\s+/g, "")));
    case "quoted-printable":
      return toBytes(qpDecode(body));
    default:
      return toBytes(body);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|tr|li|h\d|table)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

interface Walk {
  plain: string[];
  html: string[];
  attachments: EmlAttachment[];
}

function walk(raw: string, into: Walk): Record<string, string> {
  const [head, body] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const type = (headers["content-type"] ?? "text/plain").toLowerCase();
  const boundary = param(headers["content-type"], "boundary");
  if (type.startsWith("multipart/") && boundary) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n?`)).slice(1);
    for (const part of parts) if (part.trim() && part.trim() !== "--") walk(part.replace(/^\r?\n/, ""), into);
    return headers;
  }
  const bytes = decodeBody(body, headers["content-transfer-encoding"]);
  const filename = param(headers["content-disposition"], "filename") ?? param(headers["content-type"], "name");
  if (filename || (!type.startsWith("text/") && !type.startsWith("message/"))) {
    if (filename) into.attachments.push({ filename: decodeWords(filename), contentType: type.split(";")[0]!.trim(), bytes });
    return headers;
  }
  const text = decoder(param(headers["content-type"], "charset")).decode(bytes);
  (type.startsWith("text/html") ? into.html : into.plain).push(text);
  return headers;
}

export function parseEml(raw: string): EmlMessage {
  const into: Walk = { plain: [], html: [], attachments: [] };
  const headers = walk(raw, into);
  for (const k of Object.keys(headers)) headers[k] = decodeWords(headers[k]!);
  const text = into.plain.join("\n").trim() || stripHtml(into.html.join("\n"));
  return { headers, text, attachments: into.attachments };
}

/** The email as text a receipt reader can use: Subject, From and Date lines first (the sender's domain names the vendor), then the body. */
export function emlToText(raw: string): string {
  const m = parseEml(raw);
  const h = m.headers;
  const head = [["Subject", h["subject"]], ["From", h["from"]], ["Date", h["date"]]].flatMap(([k, v]) => (v ? [`${k}: ${v}`] : []));
  return [...head, "", m.text].join("\n");
}

/** Attachments worth keeping as receipts: PDFs and images. */
export const receiptAttachments = (m: EmlMessage): EmlAttachment[] => m.attachments.filter((a) => /pdf|^image\//.test(a.contentType) || /\.(pdf|jpe?g|png)$/i.test(a.filename));
