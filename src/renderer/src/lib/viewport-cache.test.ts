import { describe, expect, it } from "vite-plus/test";

import { applyViewport, createViewportCache, viewportOf } from "./viewport-cache";

describe("createViewportCache", () => {
  it("roundtrips a stored viewport", () => {
    const cache = createViewportCache();
    cache.set("a.excalidraw", { scrollX: 10, scrollY: -20, zoom: 2.5 });
    expect(cache.get("a.excalidraw")).toEqual({ scrollX: 10, scrollY: -20, zoom: 2.5 });
  });

  it("returns undefined for unknown files", () => {
    const cache = createViewportCache();
    expect(cache.get("missing.excalidraw")).toBeUndefined();
  });

  it("rejects non-finite and non-positive values on read", () => {
    const cache = createViewportCache();
    cache.set("a.excalidraw", { scrollX: Number.NaN, scrollY: 0, zoom: 1 });
    cache.set("b.excalidraw", { scrollX: 0, scrollY: Number.POSITIVE_INFINITY, zoom: 1 });
    cache.set("c.excalidraw", { scrollX: 0, scrollY: 0, zoom: 0 });
    cache.set("d.excalidraw", { scrollX: 0, scrollY: 0, zoom: -1 });
    expect(cache.get("a.excalidraw")).toBeUndefined();
    expect(cache.get("b.excalidraw")).toBeUndefined();
    expect(cache.get("c.excalidraw")).toBeUndefined();
    expect(cache.get("d.excalidraw")).toBeUndefined();
  });

  it("deletes entries", () => {
    const cache = createViewportCache();
    cache.set("a.excalidraw", { scrollX: 1, scrollY: 2, zoom: 1 });
    cache.delete("a.excalidraw");
    expect(cache.get("a.excalidraw")).toBeUndefined();
    cache.delete("a.excalidraw");
    expect(cache.get("a.excalidraw")).toBeUndefined();
  });
});

describe("viewportOf", () => {
  it("extracts the bare zoom value", () => {
    expect(viewportOf({ scrollX: 5, scrollY: 6, zoom: { value: 1.5 } })).toEqual({
      scrollX: 5,
      scrollY: 6,
      zoom: 1.5,
    });
  });

  it("falls back to zoom 1 when missing", () => {
    expect(viewportOf({ scrollX: 5, scrollY: 6 })).toEqual({ scrollX: 5, scrollY: 6, zoom: 1 });
  });
});

describe("applyViewport", () => {
  it("merges scroll and zoom into appState", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#fff" };
    const merged = applyViewport(appState, { scrollX: 100, scrollY: -50, zoom: 3 });
    expect(merged).toEqual({
      scrollX: 100,
      scrollY: -50,
      zoom: { value: 3 },
      viewBackgroundColor: "#fff",
    });
    expect(merged).not.toBe(appState);
  });

  it("preserves extra zoom properties", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1, translation: { x: 1, y: 2 } } };
    const merged = applyViewport(appState, { scrollX: 1, scrollY: 2, zoom: 2 });
    expect(merged.zoom).toEqual({ value: 2, translation: { x: 1, y: 2 } });
  });

  it("returns the input untouched when there is no viewport", () => {
    const appState = { scrollX: 1, scrollY: 2, zoom: { value: 1 } };
    expect(applyViewport(appState, undefined)).toBe(appState);
  });

  it("builds a zoom object when appState has none", () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: null };
    const merged = applyViewport(appState, { scrollX: 4, scrollY: 5, zoom: 2 });
    expect(merged.zoom).toEqual({ value: 2 });
  });
});
