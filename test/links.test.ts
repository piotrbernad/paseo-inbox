import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSource, links, segments } from "../client/links.ts";

test("links are split out of text without trailing punctuation or an unopened bracket", () => {
  assert.deepEqual(segments("See https://github.com/acme/app/pull/6. Then (https://x.dev/a_(b)) and http://y.dev/c?d=1#e!"), [
    { kind: "text", text: "See " },
    { kind: "link", url: "https://github.com/acme/app/pull/6" },
    { kind: "text", text: ". Then (" },
    { kind: "link", url: "https://x.dev/a_(b)" },
    { kind: "text", text: ") and " },
    { kind: "link", url: "http://y.dev/c?d=1#e" },
    { kind: "text", text: "!" },
  ]);
  assert.deepEqual(segments("no links, not even ftp://x or github.com/a"), [{ kind: "text", text: "no links, not even ftp://x or github.com/a" }]);
  assert.deepEqual(links("https://a.dev/1 https://a.dev/1, https://b.dev/2"), ["https://a.dev/1", "https://b.dev/2"]);
});

test("image links get a preview source; a GitHub blob page loads from raw", () => {
  assert.equal(imageSource("https://example.com/shots/home.PNG"), "https://example.com/shots/home.PNG");
  assert.equal(imageSource("https://cdn.example.com/a.webp?v=2"), "https://cdn.example.com/a.webp?v=2");
  assert.equal(
    imageSource("https://github.com/acme/design/blob/main/render/cennik.png"),
    "https://github.com/acme/design/raw/main/render/cennik.png",
  );
  assert.equal(
    imageSource("https://raw.githubusercontent.com/acme/design/main/render/home.jpg"),
    "https://raw.githubusercontent.com/acme/design/main/render/home.jpg",
  );
  const attachment = "https://github.com/user-attachments/assets/0f5c2a8e-1111-4c2b-9d1e-123456789abc";
  assert.equal(imageSource(attachment), attachment);
  for (const url of ["https://github.com/acme/design/pull/6", "https://example.com/png", "https://example.com/a.png.html", "https://example.com/doc.pdf"]) {
    assert.equal(imageSource(url), null, url);
  }
});
