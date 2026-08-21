import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEventHandler, MouseEvent, ReactNode } from "react";
import { useCallback, useMemo } from "react";

import type { FileEntry } from "@shared/ipc";

import { cn, stripExcalidraw } from "@/lib/utils";

export type FileTreePayload = FileEntry | null;
export type FileTreeItem = ItemInstance<FileTreePayload>;
export type FileTreeInstance = TreeInstance<FileTreePayload>;

type TreeIdsUpdate = string[] | ((old: string[]) => string[]);

type UseFileTreeConfig = {
  childIndex: Map<string | null, FileEntry[]>;
  expandedItems: string[];
  onExpandedItemsChange: (items: TreeIdsUpdate) => void;
  selectedItems: string[];
  onSelectedItemsChange: (items: TreeIdsUpdate) => void;
  onPrimaryAction: (item: FileTreeItem) => void;
};

export const useFileTree = ({
  childIndex,
  expandedItems,
  onExpandedItemsChange,
  selectedItems,
  onSelectedItemsChange,
  onPrimaryAction,
}: UseFileTreeConfig): FileTreeInstance => {
  const entriesById = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const children of childIndex.values()) {
      for (const entry of children) map.set(entry.id, entry);
    }
    return map;
  }, [childIndex]);

  const resolveEntry = useCallback(
    (itemId: string): FileEntry =>
      entriesById.get(itemId) ?? {
        id: itemId,
        name: "",
        kind: "file",
        parentId: null,
        modifiedAt: 0,
        size: 0,
      },
    [entriesById],
  );

  return useTree<FileTreePayload>({
    rootItemId: "",
    getItemName: (item) => {
      const name = item.getItemData()?.name ?? "";
      return stripExcalidraw(name);
    },
    isItemFolder: (item) => item.getItemData()?.kind === "directory",
    dataLoader: {
      getItem: (itemId) => resolveEntry(itemId),
      getChildren: (itemId) =>
        (childIndex.get(itemId === "" ? null : itemId) ?? []).map((entry) => entry.id),
    },
    state: { expandedItems, selectedItems },
    setExpandedItems: onExpandedItemsChange,
    setSelectedItems: onSelectedItemsChange,
    onPrimaryAction,
    indent: 16,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });
};

export const TreeContainer = ({
  tree,
  className,
  onKeyDown,
  children,
}: {
  tree: FileTreeInstance;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
}) => {
  const { onKeyDown: treeOnKeyDown, ...containerProps } = tree.getContainerProps("Drawings");

  return (
    <div
      {...containerProps}
      className={className}
      onKeyDown={(event) => {
        treeOnKeyDown?.(event);
        onKeyDown?.(event);
      }}
    >
      {children}
    </div>
  );
};

export const TreeRow = ({
  item,
  label,
  isActive,
  isDirty,
  indentPx = 16,
  onContextMenu,
}: {
  item: FileTreeItem;
  label: string;
  isActive?: boolean;
  isDirty?: boolean;
  indentPx?: number;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) => {
  const meta = item.getItemMeta();
  const level = meta.level;
  const isFolder = item.isFolder();
  const expanded = isFolder && item.isExpanded();
  const isLastSibling = meta.posInSet === meta.setSize - 1;

  const guides: ReactNode[] = [];

  for (let depth = 0; depth < level; depth++) {
    const isParentColumn = depth === level - 1;
    guides.push(
      <span
        key={depth}
        className={cn(
          "absolute border-l border-sidebar-border",
          isParentColumn && isLastSibling ? "top-0 h-1/2" : "inset-y-0",
        )}
        style={{ left: depth * indentPx + indentPx / 2 - 1 }}
      />,
    );
  }

  return (
    <button
      {...item.getProps()}
      type="button"
      title={label}
      data-active={isActive ? "true" : undefined}
      data-dirty={isDirty ? "true" : undefined}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: `${level * indentPx}px` }}
      className={cn(
        "relative flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm outline-hidden transition-colors hover:bg-sidebar-accent focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium",
        isDirty && "dirty-dot",
      )}
    >
      {level > 0 && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
          {guides}
          <span
            className="absolute top-1/2 border-t border-sidebar-border"
            style={{
              left: (level - 1) * indentPx + indentPx / 2 - 1,
              width: indentPx - 6,
            }}
          />
        </span>
      )}
      <span
        aria-hidden
        className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      >
        {isFolder ? (
          <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        ) : null}
      </span>
      <span className="relative truncate">{label}</span>
      {isDirty ? <span className="sr-only">(unsaved changes)</span> : null}
    </button>
  );
};
