import { CheckIcon } from "./icons";

export type StatusKind =
  | "empty"
  | "error"
  | "hint"
  | "loading"
  | "success"
  | "warning";

export interface StatusMessageValue {
  kind: StatusKind;
  text: string;
}

interface StatusMessageProps {
  fading?: boolean;
  liveText?: string;
  message: StatusMessageValue | null;
}

function ErrorGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function messageClassName(kind: StatusKind, fading: boolean): string {
  switch (kind) {
    case "empty":
      return "text-meta text-ink-2";
    case "error":
      return "flex items-center gap-2 rounded-row bg-danger-bg p-4 text-meta text-danger-ink";
    case "hint":
      return "text-sm text-zinc-400";
    case "loading":
      return "sr-only";
    case "success":
      return `flex items-center gap-2 rounded-row bg-success-bg px-4 py-3 text-meta text-success-ink motion-safe:animate-notice-in motion-safe:transition-opacity duration-150 ${
        fading ? "opacity-0" : "opacity-100"
      }`;
    case "warning":
      return "text-sm text-amber-300";
  }
}

export function StatusMessage({
  fading = false,
  liveText,
  message,
}: StatusMessageProps) {
  const isError = message?.kind === "error";
  const visibleMessage =
    message !== null &&
    message.kind !== "loading" &&
    message.kind !== "error";
  const statusText = isError
    ? ""
    : liveText ?? message?.text ?? "";
  const alertText = isError ? message.text : "";

  return (
    <div className="min-h-6">
      <p
        aria-live="polite"
        className={
          visibleMessage
            ? messageClassName(message.kind, fading)
            : "sr-only"
        }
        id="search-status"
        role="status"
      >
        {visibleMessage && message.kind === "success" ? (
          <CheckIcon className="size-4 shrink-0" />
        ) : null}
        {statusText}
      </p>
      <p
        aria-live="assertive"
        className={
          isError ? messageClassName("error", false) : "sr-only"
        }
        id="search-alert"
        role="alert"
      >
        {isError ? <ErrorGlyph /> : null}
        {alertText}
      </p>
      {isError ? (
        <p className="mt-1 text-meta text-ink-2">
          Você ainda pode apertar Enter para tentar de novo.
        </p>
      ) : null}
    </div>
  );
}
