import { useCallback, useEffect, useRef, useState } from "react";

export const useListBottomFade = (open: boolean) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [bottomFade, setBottomFade] = useState(false);

  const updateBottomFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setBottomFade(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    if (!open) return () => {};
    updateBottomFade();
    const el = listRef.current;
    if (!el) return () => {};
    const ro = new ResizeObserver(() => updateBottomFade());
    ro.observe(el);
    const mo = new MutationObserver(() => updateBottomFade());
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [updateBottomFade, open]);

  return { listRef, bottomFade, updateBottomFade };
};
