import { errorWithCode } from "@shared/errors";

export const EMPTY_DRAWING_CONTENT =
  '{"type":"excalidraw","version":2,"source":"xdrawz","elements":[],"appState":{},"files":{}}';

export const assertDrawingJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw errorWithCode("Drawing content is not valid JSON", "INVALID");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errorWithCode("Drawing must be a JSON object", "INVALID");
  }

  const drawing = parsed;
  if ("elements" in drawing && !Array.isArray(drawing.elements)) {
    throw errorWithCode("Drawing elements must be an array when present", "INVALID");
  }

  if (
    "files" in drawing &&
    (drawing.files === null || typeof drawing.files !== "object" || Array.isArray(drawing.files))
  ) {
    throw errorWithCode("Drawing files must be an object when present", "INVALID");
  }
};
