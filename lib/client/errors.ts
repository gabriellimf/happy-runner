import { ClientApiError, ClientNetworkError } from "./api";

export const CLIENT_MESSAGES = {
  alreadyInQueue:
    "Essa música já está na fila. Enter de novo para adicionar.",
  emptySearch: "Nenhuma música encontrada",
  genericError: "Algo deu errado, tente de novo",
  noActiveDevice: "Player offline, tente em instantes",
  offline: "Sem conexão. Verifique sua internet e tente de novo",
  pickSuggestion: "Não tenho certeza. Toque em uma sugestão",
  rateLimited: "Muita gente pedindo, tente de novo",
  shortQuery: "Digite pelo menos 4 letras",
  trackCopyLimit:
    "Essa música já está na fila duas vezes. Não pode ser adicionada de novo.",
  versionInQueue:
    "Já tem uma versão dessa música na fila. Toque nela para adicionar mesmo assim",
} as const;

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function isOfflineError(
  error: unknown,
  isOnline = browserIsOnline(),
): boolean {
  return (
    !isOnline ||
    error instanceof ClientNetworkError ||
    error instanceof TypeError
  );
}

export function getClientErrorMessage(
  error: unknown,
  isOnline = browserIsOnline(),
): string {
  if (isOfflineError(error, isOnline)) {
    return CLIENT_MESSAGES.offline;
  }

  if (error instanceof ClientApiError) {
    switch (error.code) {
      case "ALREADY_IN_QUEUE":
        return CLIENT_MESSAGES.alreadyInQueue;
      case "TRACK_COPY_LIMIT":
        return CLIENT_MESSAGES.trackCopyLimit;
      case "NO_ACTIVE_DEVICE":
        return CLIENT_MESSAGES.noActiveDevice;
      case "RATE_LIMITED":
        return CLIENT_MESSAGES.rateLimited;
      case "INVALID_INPUT":
      case "UPSTREAM_ERROR":
      case "INTERNAL_ERROR":
      default:
        return CLIENT_MESSAGES.genericError;
    }
  }

  return CLIENT_MESSAGES.genericError;
}
