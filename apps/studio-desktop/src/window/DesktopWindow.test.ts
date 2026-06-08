import { expect, test } from "bun:test";

import { isSameAppOrigin } from "./DesktopWindow.ts";

// Dev origin = the vite dev server (http://127.0.0.1:1739).
test("dev: same-origin navigation (with/without query, any path) is allowed", () => {
  expect(isSameAppOrigin("http://127.0.0.1:1739/", true)).toBe(true);
  expect(isSameAppOrigin("http://127.0.0.1:1739/some/route", true)).toBe(true);
  expect(isSameAppOrigin("http://127.0.0.1:1739/?endpoint=http://x", true)).toBe(true);
});

test("dev: foreign hosts/schemes are rejected", () => {
  expect(isSameAppOrigin("https://evil.com", true)).toBe(false);
  expect(isSameAppOrigin("http://127.0.0.1:9999/", true)).toBe(false); // different port
  expect(isSameAppOrigin("https://127.0.0.1:1739/", true)).toBe(false); // different scheme
  expect(isSameAppOrigin("ax://studio/index.html", true)).toBe(false); // prod scheme in dev
});

// Prod origin = the custom ax://studio scheme.
test("prod: same ax://studio origin is allowed across paths/queries", () => {
  expect(isSameAppOrigin("ax://studio/index.html", false)).toBe(true);
  expect(isSameAppOrigin("ax://studio/other/route", false)).toBe(true);
  expect(isSameAppOrigin("ax://studio/index.html?endpoint=x", false)).toBe(true);
});

test("prod: foreign ax host is rejected (origin 'null' over-match guarded)", () => {
  // Both ax://studio and ax://evil report origin "null"; protocol+host check
  // must still distinguish them.
  expect(isSameAppOrigin("ax://evil/index.html", false)).toBe(false);
  expect(isSameAppOrigin("https://evil.com", false)).toBe(false);
  expect(isSameAppOrigin("http://127.0.0.1:1739/", false)).toBe(false); // dev origin in prod
});

test("malformed urls are rejected", () => {
  expect(isSameAppOrigin("not a url", true)).toBe(false);
  expect(isSameAppOrigin("", false)).toBe(false);
});
