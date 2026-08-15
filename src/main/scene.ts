export const assertSceneJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Scene content is not valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Scene must be a JSON object");
  }

  const scene = parsed;
  if ("elements" in scene && !Array.isArray(scene.elements)) {
    throw new Error("Scene.elements must be an array when present");
  }

  if (
    "files" in scene &&
    (scene.files === null || typeof scene.files !== "object" || Array.isArray(scene.files))
  ) {
    throw new Error("Scene.files must be an object when present");
  }
};
