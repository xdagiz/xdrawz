import { Skeleton } from "@/components/ui/skeleton";

export const SidebarLoading = () => {
  return (
    <div className="flex flex-col gap-4 px-2 py-4" aria-label="Loading drawings">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-4" style={{ width: `${80 - row * 6}%` }} />
      ))}
    </div>
  );
};
