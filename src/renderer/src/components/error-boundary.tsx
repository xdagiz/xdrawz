import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { toAppError, type AppError } from "@/lib/app-error";
import { reportRendererError } from "@/lib/report-error";

type ErrorBoundaryProps = {
  children: ReactNode;
  title?: string;
  description?: string;
  onError?: (error: AppError) => void;
  resetKeys?: unknown[];
  onReset?: () => void;
};

const toBoundaryError = (error: unknown): AppError => toAppError(error, "unexpected");

export const ErrorBoundary = ({
  children,
  title,
  description,
  onError,
  resetKeys,
  onReset,
}: ErrorBoundaryProps) => {
  const handleError = (error: unknown) => {
    reportRendererError(error);
    onError?.(toBoundaryError(error));
  };

  const renderFallback = ({ resetErrorBoundary }: FallbackProps) => (
    <Empty className="bg-background h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon className="text-destructive" />
        </EmptyMedia>
        <EmptyTitle>{title ?? "Something went wrong"}</EmptyTitle>
        <EmptyDescription>
          {description ?? "Try again. If this keeps happening, copy the details for support."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={resetErrorBoundary}>
          <RefreshCwIcon />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );

  return (
    <ReactErrorBoundary
      fallbackRender={renderFallback}
      onError={handleError}
      resetKeys={resetKeys}
      onReset={onReset}
    >
      {children}
    </ReactErrorBoundary>
  );
};
