export type Viewport = {
  scrollX: number;
  scrollY: number;
  zoom: number;
};

export type ViewportCache = {
  get: (fileId: string) => Viewport | undefined;
  set: (fileId: string, viewport: Viewport) => void;
  delete: (fileId: string) => void;
};

export const MAX_VIEWPORT_CACHE_SIZE = 200;

export const createViewportCache = (): ViewportCache => {
  const entries = new Map<string, Viewport>();

  return {
    get: (fileId) => {
      const viewport = entries.get(fileId);
      if (!viewport) return undefined;
      if (!Number.isFinite(viewport.scrollX) || !Number.isFinite(viewport.scrollY)) {
        return undefined;
      }
      if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return undefined;
      return { ...viewport };
    },
    set: (fileId, viewport) => {
      if (!viewport || typeof viewport !== "object") return;
      if (!Number.isFinite(viewport.scrollX) || !Number.isFinite(viewport.scrollY)) return;
      if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return;
      if (!entries.has(fileId) && entries.size >= MAX_VIEWPORT_CACHE_SIZE) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(fileId, { ...viewport });
    },
    delete: (fileId) => {
      entries.delete(fileId);
    },
  };
};

export const viewportOf = (appState: {
  scrollX: number;
  scrollY: number;
  zoom?: { value: number };
}): Viewport => ({
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
  zoom: appState.zoom?.value ?? 1,
});

export const applyViewport = <T extends { scrollX: number; scrollY: number; zoom: unknown }>(
  appState: T,
  viewport: Viewport | undefined,
): T => {
  if (!viewport) return appState;
  const zoom =
    typeof appState.zoom === "object" && appState.zoom !== null
      ? { ...appState.zoom, value: viewport.zoom }
      : { value: viewport.zoom };
  return { ...appState, scrollX: viewport.scrollX, scrollY: viewport.scrollY, zoom };
};
