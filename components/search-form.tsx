interface SearchFormProps {
  isAdding: boolean;
  isDisabled: boolean;
  inputRef: (input: HTMLInputElement | null) => void;
  onSubmit: () => void;
  onTextChange: (text: string) => void;
  text: string;
}

export function SearchForm({
  isAdding,
  isDisabled,
  inputRef,
  onSubmit,
  onTextChange,
  text,
}: SearchFormProps) {
  return (
    <form
      className="flex min-w-0 gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="music-search">
        Buscar música
      </label>
      <input
        aria-describedby="search-status search-alert"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        autoFocus
        className="h-14 min-w-0 flex-1 scroll-mt-4 rounded-pill border border-field-edge bg-surface-2 px-5 text-input text-ink outline-none placeholder:text-ink-3 focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base"
        enterKeyHint="send"
        id="music-search"
        inputMode="search"
        maxLength={100}
        name="q"
        onChange={(event) => onTextChange(event.currentTarget.value)}
        placeholder="Música ou artista"
        ref={inputRef}
        spellCheck={false}
        type="text"
        value={text}
      />
      <button
        aria-busy={isAdding || undefined}
        aria-disabled={isDisabled}
        className={`h-14 min-w-[112px] shrink-0 whitespace-nowrap rounded-pill px-5 text-body touch-manipulation motion-safe:active:scale-[0.97] motion-safe:transition-transform duration-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base ${
          isAdding
            ? "bg-accent text-on-accent opacity-80"
            : isDisabled
              ? "bg-surface-3 text-ink-3"
              : "bg-accent text-on-accent"
        }`}
        type="submit"
      >
        {isAdding ? "Adicionando..." : "Adicionar"}
      </button>
    </form>
  );
}
