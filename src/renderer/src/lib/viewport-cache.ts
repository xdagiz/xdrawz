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
      return viewport;
    },
    set: (fileId, viewport) => {
      entries.set(fileId, viewport);
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
