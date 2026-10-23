interface IconProps {
  className?: string;
}

function strokeIcon(className?: string) {
  return {
    "aria-hidden": true as const,
    className,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.75,
    viewBox: "0 0 24 24",
  };
}

export function PlusIcon({ className = "size-5" }: IconProps) {
  return (
    <svg {...strokeIcon(className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CheckIcon({ className = "size-5" }: IconProps) {
  return (
    <svg {...strokeIcon(className)}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function WifiOffIcon({ className = "size-5" }: IconProps) {
  return (
    <svg {...strokeIcon(className)}>
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.55a10 10 0 0 1 14.08 0" />
      <path d="M8.5 16.43a5 5 0 0 1 7 0" />
      <path d="M12 20h.01" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

export function ClockIcon({ className = "size-5" }: IconProps) {
  return (
    <svg {...strokeIcon(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function MusicNoteIcon({ className = "size-5" }: IconProps) {
  return (
    <svg {...strokeIcon(className)}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}
