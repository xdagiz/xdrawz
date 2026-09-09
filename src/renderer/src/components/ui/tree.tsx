import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import type { KeyboardEventHandler, MouseEvent, MouseEventHandler, ReactNode } from "react";
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
  onContextMenu,
  children,
}: {
  tree: FileTreeInstance;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
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
      onContextMenu={onContextMenu}
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
  timeLabel,
  onMenuClick,
  onContextMenu,
}: {
  item: FileTreeItem;
  label: string;
  isActive?: boolean;
  isDirty?: boolean;
  indentPx?: number;
  timeLabel?: string;
  onMenuClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
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
          "absolute border-l border-border-quiet",
          isParentColumn && isLastSibling ? "top-0 h-1/2" : "inset-y-0",
        )}
        style={{ left: depth * indentPx + indentPx / 2 - 1 }}
      />,
    );
  }

  if (isFolder) {
    return (
      <div
        data-active={isActive ? "true" : undefined}
        onContextMenu={onContextMenu}
        className="group/row relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 transition-colors outline-hidden hover:bg-sidebar-accent/60 focus-within:z-10 has-[:focus-visible]:ring-1.5 has-[:focus-visible]:ring-sidebar-ring data-[active=true]:bg-sidebar-accent"
      >
        <button
          {...item.getProps()}
          type="button"
          title={label}
          style={{ paddingLeft: `${level * indentPx}px` }}
          className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm outline-hidden group-data-[active=true]/row:font-medium"
        >
        {level > 0 && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
            {guides}
            <span
              className="absolute top-1/2 border-t border-border-quiet"
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
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </span>
        <span className="truncate text-sidebar-foreground/90 transition-colors group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-sidebar-foreground">{label}</span>
        </button>
        {onMenuClick ? (
          <button
            type="button"
            aria-label={`Actions for ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onMenuClick(event);
            }}
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:block group-hover/row:block group-focus-within/row:block"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-active={isActive ? "true" : undefined}
      data-dirty={isDirty ? "true" : undefined}
      onContextMenu={onContextMenu}
      className="group/row relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 transition-colors outline-hidden hover:bg-sidebar-accent/60 focus-within:z-10 has-[:focus-visible]:ring-1.5 has-[:focus-visible]:ring-sidebar-ring data-[active=true]:bg-sidebar-accent"
    >
      <button
        {...item.getProps()}
        type="button"
        title={label}
        style={{ paddingLeft: `${level * indentPx}px` }}
        className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm outline-hidden group-data-[active=true]/row:font-medium"
      >
        {level > 0 && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
            {guides}
            <span
              className="absolute top-1/2 border-t border-border-quiet"
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
        />
        <span className="relative min-w-0 flex-1 truncate text-sidebar-foreground/90 transition-colors group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-sidebar-foreground">
          {label}
        </span>
        {isDirty ? (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
            <span className="sr-only">(unsaved changes)</span>
          </>
        ) : timeLabel ? (
          <span
            data-testid="tree-row-time"
            className="shrink-0 font-mono text-[10.5px] text-muted-foreground/80 group-hover/row:hidden group-focus-within/row:hidden"
          >
            {timeLabel}
          </span>
        ) : null}
      </button>
      {onMenuClick ? (
        <button
          type="button"
          aria-label={`Actions for ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onMenuClick(event);
          }}
          className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:block group-hover/row:block group-focus-within/row:block"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
};
