/**
 * Detects captcha response fields (hCaptcha, reCAPTCHA, Turnstile) in captured
 * request bodies. A solved captcha token is single-use and can never be
 * produced by a plugin, so a flow that submits one cannot be a live-replayable
 * HTTP hot path.
 */

export const CAPTCHA_RESPONSE_FIELDS: readonly string[] = [
  "h-captcha-response",
  "g-recaptcha-response",
  "cf-turnstile-response",
];

export interface MultipartTextPart {
  name: string;
  value: string;
}

/** Parses the form-data parts of a text-captured multipart body. */
export function parseMultipartTextParts(raw: string): MultipartTextPart[] {
  const parts: MultipartTextPart[] = [];
  const first = /^--([^\r\n]+)\r?\n/.exec(raw.trimStart());
  if (first === null) return parts;
  const boundary = first[1] as string;
  for (const chunk of raw.split(`--${boundary}`)) {
    const m = /^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(chunk.replace(/^\r?\n/, ""));
    if (m === null) continue;
    const name = /content-disposition:[^\r\n]*?\bname="([^"]*)"/i.exec(m[1] as string);
    if (name === null) continue;
    parts.push({ name: name[1] as string, value: (m[2] as string).replace(/\r?\n$/, "") });
  }
  return parts;
}

const isCaptchaField = (name: string): boolean =>
  CAPTCHA_RESPONSE_FIELDS.includes(name.toLowerCase());

function walkJson(node: unknown, out: MultipartTextPart[], depth = 0): void {
  if (depth > 20 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkJson(n, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (isCaptchaField(k)) out.push({ name: k, value: typeof v === "string" ? v : "" });
    else walkJson(v, out, depth + 1);
  }
}

/** Captcha response fields (name + value) carried by a JSON, urlencoded or multipart body. */
export function findCaptchaResponseFields(raw: string): MultipartTextPart[] {
  const found: MultipartTextPart[] = [];
  if (raw === "") return found;
  try {
    walkJson(JSON.parse(raw) as unknown, found);
    return found;
  } catch {
    // not JSON
  }
  const multipart = parseMultipartTextParts(raw);
  if (multipart.length > 0) return multipart.filter((p) => isCaptchaField(p.name));
  for (const [k, v] of new URLSearchParams(raw)) {
    if (isCaptchaField(k)) found.push({ name: k, value: v });
  }
  return found;
}
