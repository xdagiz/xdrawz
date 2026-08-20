import { errorWithCode } from "@shared/errors";

export const assertSceneJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw errorWithCode("Scene content is not valid JSON", "INVALID");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errorWithCode("Scene must be a JSON object", "INVALID");
  }

  const scene = parsed;
  if ("elements" in scene && !Array.isArray(scene.elements)) {
    throw errorWithCode("Scene.elements must be an array when present", "INVALID");
  }

  if (
    "files" in scene &&
    (scene.files === null || typeof scene.files !== "object" || Array.isArray(scene.files))
  ) {
    throw errorWithCode("Scene.files must be an object when present", "INVALID");
  }
};
