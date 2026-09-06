const stripRemoteSources = (source) =>
  typeof source === "string"
    ? source
        .replace(/@import\s+(?:url\(\s*["']?https?:[^)]+\)|["']https?:[^"']+["']);?/g, "")
        .replace(/url\(\s*["']?https?:[^)]+\)/g, "")
    : source;

(function () {
  "use strict";

  window.EXCALIDRAW_ASSET_PATH = new URL("/", window.location.origin).toString();

  const OriginalFontFace = window.FontFace;
  window.FontFace = function (family, source, descriptors) {
    return new OriginalFontFace(family, stripRemoteSources(source), descriptors);
  };

  window.FontFace.prototype = OriginalFontFace.prototype;
})();
