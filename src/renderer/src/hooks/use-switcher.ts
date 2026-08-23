import { useHotkey } from "@tanstack/react-hotkeys";
import { useEffect, useRef, useState } from "react";

import { isCloseHandshakeActive, onCloseHandshakeStart } from "@/lib/close-handshake";
import { selectRecentFiles } from "@/lib/recent-files";
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

  const controllerRef = useRef<SwitcherController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSwitcherController({
      getCandidates: () =>
        selectRecentFiles(useStore.getState().recentFileIds, useStore.getState().entries).map(
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

  useHotkey("Control+Tab", () => controller.start(), { preventDefault: false });
  useHotkey("Control+Shift+Tab", () => controller.step(-1), { preventDefault: false });

  useEffect(() => {
    if (state.phase !== "cycling") return undefined;

    const held = new Set(["Control", "Tab"]);
    heldKeysRef.current = held;

    const commitIfFullyReleased = () => {
      if (held.size === 0) controller.commit();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta" || event.key === "Tab") {
        held.add(event.key);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!held.delete(event.key)) return;
      commitIfFullyReleased();
    };

    const onBlur = () => controller.cancel();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      heldKeysRef.current = new Set();
    };
  }, [state.phase, controller]);

  return {
    state,
    commitAt: (index: number) => controller.commitAt(index),
    cancel: () => controller.cancel(),
  };
};
