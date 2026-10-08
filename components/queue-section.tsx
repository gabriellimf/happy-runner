import type { QueueState } from "../lib/client/queue-machine";
import { NextList } from "./next-list";
import { NowPlaying } from "./now-playing";

interface QueueSectionProps {
  state: QueueState;
}

const QUEUE_NOTICE_COPY = {
  error: "Não foi possível atualizar a fila",
  offlineWithData: "Sem conexão. Mostrando a última fila",
  offlineWithoutData: "Sem conexão",
  "rate-limited": "Muita gente pedindo, atualizando em instantes",
} as const;

function QueueSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
        <span className="size-24 rounded-lg bg-zinc-800 motion-safe:animate-pulse" />
        <span className="space-y-2">
          <span className="block h-4 w-3/4 rounded bg-zinc-800 motion-safe:animate-pulse" />
          <span className="block h-3 w-1/2 rounded bg-zinc-800 motion-safe:animate-pulse" />
        </span>
      </div>
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            className="grid min-h-14 grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 rounded-xl bg-zinc-900 p-2"
            key={`queue-skeleton-${index}`}
          >
            <span className="size-12 rounded-lg bg-zinc-800 motion-safe:animate-pulse" />
            <span className="space-y-2">
              <span className="block h-4 w-3/4 rounded bg-zinc-800 motion-safe:animate-pulse" />
              <span className="block h-3 w-1/2 rounded bg-zinc-800 motion-safe:animate-pulse" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function noticeText(state: QueueState): string | null {
  switch (state.notice) {
    case "error":
      return QUEUE_NOTICE_COPY.error;
    case "offline":
      return state.data
        ? QUEUE_NOTICE_COPY.offlineWithData
        : QUEUE_NOTICE_COPY.offlineWithoutData;
    case "rate-limited":
      return QUEUE_NOTICE_COPY["rate-limited"];
    default:
      return null;
  }
}

export function QueueSection({ state }: QueueSectionProps) {
  const message = noticeText(state);
  const liveText =
    message ??
    (!state.data && state.isLoading ? "Carregando fila..." : "");

  return (
    <section aria-label="Fila" className="space-y-4">
      <p
        aria-live="polite"
        className={message ? "text-sm text-amber-300" : "sr-only"}
        role="status"
      >
        {liveText}
      </p>
      {state.data ? (
        <div className="space-y-6">
          <NowPlaying track={state.data.nowPlaying} />
          {state.data.nowPlaying ? <NextList tracks={state.data.next} /> : null}
        </div>
      ) : state.isLoading && !state.notice ? (
        <QueueSkeleton />
      ) : null}
    </section>
  );
}
