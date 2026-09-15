"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";

import { cn } from "@/lib/utils";

const Autocomplete = AutocompletePrimitive.Root;

function AutocompleteInput({
  className,
  startAddon,
  ...props
}: AutocompletePrimitive.Input.Props & {
  startAddon?: React.ReactNode;
}) {
  return (
    <div className="relative w-full text-foreground">
      {startAddon && (
        <div
          aria-hidden="true"
          data-slot="autocomplete-start-addon"
          className="pointer-events-none absolute inset-y-0 start-0 z-10 flex items-center ps-2.5 opacity-80 [&_svg:not([class*='size-'])]:size-4"
        >
          {startAddon}
        </div>
      )}
      <AutocompletePrimitive.Input
        data-slot="autocomplete-input"
        className={cn(
          "h-9 w-full min-w-0 rounded-md border border-transparent bg-transparent py-1 pr-2.5 text-sm shadow-none transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          startAddon && "ps-9",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function AutocompleteItem({ className, children, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-highlighted:bg-muted data-highlighted:text-foreground data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        className,
      )}
      data-slot="autocomplete-item"
      {...props}
    >
      {children}
    </AutocompletePrimitive.Item>
  );
}

function AutocompleteSeparator({ className, ...props }: AutocompletePrimitive.Separator.Props) {
  return (
    <AutocompletePrimitive.Separator
      className={cn("-mx-1 h-px w-auto bg-border-quiet last:hidden", className)}
      data-slot="autocomplete-separator"
      {...props}
    />
  );
}

function AutocompleteGroup({ className, ...props }: AutocompletePrimitive.Group.Props) {
  return (
    <AutocompletePrimitive.Group
      className={cn("overflow-hidden p-1 text-foreground", className)}
      data-slot="autocomplete-group"
      {...props}
    />
  );
}

function AutocompleteGroupLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      data-slot="autocomplete-group-label"
      {...props}
    />
  );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      className={cn(
        "no-scrollbar scroll-py-1 overflow-x-hidden overflow-y-auto px-1 outline-none",
        className,
      )}
      data-slot="autocomplete-list"
      {...props}
    />
  );
}

function AutocompleteCollection({ ...props }: AutocompletePrimitive.Collection.Props) {
  return <AutocompletePrimitive.Collection data-slot="autocomplete-collection" {...props} />;
}

export {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteSeparator,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteList,
  AutocompleteCollection,
};
