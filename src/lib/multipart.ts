/**
 * RFC 7578 multipart/form-data byte-assembly primitives.
 *
 * Site-agnostic helpers for hand-building multipart bodies without the
 * browser FormData API. Boundary generation follows WebKit's convention
 * (`----WebKitFormBoundary` + 16 lowercase hex chars) so servers that
 * parse the Content-Type boundary token recognise it as a browser upload.
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a fresh multipart boundary using the WebKit convention.
 * The prefix makes the boundary recognisable to parsers that inspect
 * the User-Agent, and the 8 random bytes (16 hex chars) make collisions
 * astronomically unlikely within a single request body.
 */
export function makeBoundary(): string {
  return `----WebKitFormBoundary${randomBytes(8).toString("hex")}`;
}

/**
 * Append a `name=value` text part to the running parts list.
 * Separating each part into a discrete push keeps the buffer assembly
 * testable and avoids string-concatenating binary-adjacent content.
 */
export function appendTextPart(
  parts: Buffer[],
  boundary: string,
  name: string,
  value: string
): void {
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
  parts.push(Buffer.from(`${value}\r\n`));
}

/**
 * Append a file part to the running parts list. The `filename=` token
 * on the Content-Disposition header is what distinguishes a file part
 * from a plain text part per RFC 7578 §4.2.
 */
export function appendFilePart(
  parts: Buffer[],
  boundary: string,
  name: string,
  filename: string,
  contentType: string,
  bytes: Buffer
): void {
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(
    Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`)
  );
  parts.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`));
  parts.push(bytes);
  parts.push(Buffer.from("\r\n"));
}

/**
 * Append the RFC 7578 §4.1 closing boundary marker (`--boundary--\r\n`).
 * The trailing `--` after the boundary value is load-bearing: parsers
 * that stream the body will wait for more parts if it is absent.
 */
export function appendClosingBoundary(parts: Buffer[], boundary: string): void {
  parts.push(Buffer.from(`--${boundary}--\r\n`));
}
