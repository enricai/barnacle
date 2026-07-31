import { describe, expect, it } from "vitest";

import {
  appendClosingBoundary,
  appendFilePart,
  appendTextPart,
  makeBoundary,
} from "@/lib/multipart";

describe("makeBoundary", () => {
  it("returns a string starting with the WebKit prefix", () => {
    const boundary = makeBoundary();
    expect(boundary).toMatch(/^----WebKitFormBoundary[a-f0-9]{16}$/);
  });

  it("returns a unique value on each call", () => {
    const a = makeBoundary();
    const b = makeBoundary();
    expect(a).not.toBe(b);
  });
});

describe("appendTextPart", () => {
  it("emits boundary line, disposition header, and value — all CRLF-terminated", () => {
    const parts: Buffer[] = [];
    appendTextPart(parts, "testboundary", "fieldname", "fieldvalue");
    const body = Buffer.concat(parts).toString("utf8");
    expect(body).toBe(
      "--testboundary\r\n" +
        'Content-Disposition: form-data; name="fieldname"\r\n\r\n' +
        "fieldvalue\r\n"
    );
  });

  it("uses the provided boundary exactly", () => {
    const parts: Buffer[] = [];
    appendTextPart(parts, "----WebKitFormBoundaryaabbccdd11223344", "n", "v");
    const body = Buffer.concat(parts).toString("utf8");
    expect(body).toContain("--" + "----WebKitFormBoundaryaabbccdd11223344" + "\r\n");
  });
});

describe("appendFilePart", () => {
  it("emits boundary, disposition with filename=, content-type, bytes, and trailing CRLF", () => {
    const parts: Buffer[] = [];
    const bytes = Buffer.from("PDFBYTES");
    appendFilePart(parts, "boundary123", "filefield", "doc.pdf", "application/pdf", bytes);
    const body = Buffer.concat(parts).toString("utf8");
    expect(body).toBe(
      "--boundary123\r\n" +
        'Content-Disposition: form-data; name="filefield"; filename="doc.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\n" +
        "PDFBYTES" +
        "\r\n"
    );
  });

  it("preserves binary byte content verbatim", () => {
    const parts: Buffer[] = [];
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    appendFilePart(parts, "b", "f", "x.bin", "application/octet-stream", bytes);
    const concat = Buffer.concat(parts);
    // Find the double-CRLF that ends the headers
    const headerEnd = concat.indexOf("\r\n\r\n");
    const afterHeaders = concat.slice(headerEnd + 4);
    expect(afterHeaders.slice(0, 4)).toEqual(bytes);
  });
});

describe("appendClosingBoundary", () => {
  it("emits --boundary-- followed by CRLF", () => {
    const parts: Buffer[] = [];
    appendClosingBoundary(parts, "myboundary");
    expect(Buffer.concat(parts).toString("utf8")).toBe("--myboundary--\r\n");
  });
});
