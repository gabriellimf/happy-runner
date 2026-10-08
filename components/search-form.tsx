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
        className="h-14 min-w-0 flex-1 scroll-mt-4 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-lg text-zinc-100 outline-none placeholder:text-zinc-500 focus-visible:ring-3 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
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
        className={`h-14 min-w-[88px] shrink-0 whitespace-nowrap rounded-xl px-3 text-sm font-semibold touch-manipulation active:scale-[0.98] motion-safe:transition-transform duration-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
          isDisabled
            ? "bg-zinc-800 text-zinc-400"
            : "bg-emerald-400 text-zinc-950"
        }`}
        type="submit"
      >
        {isAdding ? "Adicionando..." : "Adicionar"}
      </button>
    </form>
  );
}
