import { useHotkey } from "@tanstack/react-hotkeys";
import { useEffect, useRef, useState } from "react";

import { isCloseHandshakeActive, onCloseHandshakeStart } from "@/lib/close-handshake";
import { selectRecentLibrary } from "@/lib/recent-files";
import { useStore } from "@/lib/store";
import {
  createSwitcherController,
  type SwitcherController,
  type SwitcherState,
} from "@/lib/switcher-controller";

type UseSwitcherOptions = {
  paletteOpen?: boolean;
};

export const useSwitcher = ({ paletteOpen = false }: UseSwitcherOptions = {}) => {
  const [state, setState] = useState<SwitcherState>({ phase: "idle" });
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;
  const heldKeysRef = useRef<Set<string>>(new Set());
  const detachReleaseRef = useRef<(() => void) | null>(null);

  const controllerRef = useRef<SwitcherController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSwitcherController({
      getCandidates: () =>
        selectRecentLibrary(useStore.getState().recentFileIds, useStore.getState().entries).map(
          (entry) => entry.id,
        ),
      canSwitchNow: () => {
        if (isCloseHandshakeActive()) return false;
        const { externalConflict, settingsDialogOpen } = useStore.getState();
        return !externalConflict && !settingsDialogOpen && !paletteOpenRef.current;
      },
      canAutoCommit: () => heldKeysRef.current.size === 0,
      commit: (fileId) => {
        void useStore.getState().setOpenFileId(fileId);
      },
      onChange: setState,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => onCloseHandshakeStart(() => controller.cancel()), [controller]);

  const beginReleaseTracking = () => {
    detachReleaseRef.current?.();
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key;
      if (key !== "Control" && key !== "Meta" && key !== "Tab") return;
      heldKeysRef.current.delete(key);
      if (heldKeysRef.current.size === 0) {
        detachReleaseRef.current?.();
        detachReleaseRef.current = null;
        controller.commit();
      }
    };
    window.addEventListener("keyup", onKeyUp, true);
    detachReleaseRef.current = () => window.removeEventListener("keyup", onKeyUp, true);
  };

  useHotkey(
    "Control+Tab",
    () => {
      if (controller.getState().phase === "cycling") {
        controller.step(1);
        return;
      }
      heldKeysRef.current = new Set(["Control", "Tab"]);
      beginReleaseTracking();
      controller.start();
    },
    { preventDefault: false },
  );
  useHotkey("Control+Shift+Tab", () => controller.step(-1), { preventDefault: false });

  useEffect(() => {
    if (state.phase !== "cycling") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta" || event.key === "Tab") {
        heldKeysRef.current.add(event.key);
      }
    };

    const onBlur = () => controller.cancel();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      detachReleaseRef.current?.();
      detachReleaseRef.current = null;
      heldKeysRef.current = new Set();
    };
  }, [state.phase, controller]);

  return {
    state,
    commitAt: (index: number) => controller.commitAt(index),
    cancel: () => controller.cancel(),
  };
};
