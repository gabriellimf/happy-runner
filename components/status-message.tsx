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

function messageClassName(kind: StatusKind, fading: boolean): string {
  switch (kind) {
    case "empty":
      return "text-sm text-zinc-300";
    case "error":
      return "rounded-xl border border-red-900 bg-red-950/60 p-3 text-sm text-red-300";
    case "hint":
      return "text-sm text-zinc-400";
    case "loading":
      return "sr-only";
    case "success":
      return `rounded-xl border border-emerald-900 bg-emerald-950/50 p-3 text-sm text-emerald-300 motion-safe:transition-opacity duration-150 ${
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
        {alertText}
      </p>
      {isError ? (
        <p className="mt-1 text-sm text-zinc-400">
          Você ainda pode apertar Enter para tentar de novo.
        </p>
      ) : null}
    </div>
  );
}
