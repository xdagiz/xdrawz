import { FilePlus2Icon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const EmptyDrawings = ({ action }: { action?: ReactNode }) => (
  <Empty className="border-0 px-1">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <FilePlus2Icon />
      </EmptyMedia>
      <EmptyTitle>No drawings yet</EmptyTitle>
      <EmptyDescription>
        Create your first drawing or pick a folder that holds .excalidraw files.
      </EmptyDescription>
    </EmptyHeader>
    {action ? <EmptyContent>{action}</EmptyContent> : null}
  </Empty>
);
