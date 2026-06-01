/**
 * Inlined ktx mascot, ported from assets/ktx-mascot.svg.
 *
 * - `light` renders the dark-bodied mascot for light surfaces.
 * - `dark` renders the cream-bodied mascot for dark surfaces (e.g. the ktx
 *   hub panel), mirroring brand/ktx-mascot-dark.svg.
 */
export function KtxMascot({
  variant = "light",
  size = 56,
}: {
  variant?: "light" | "dark";
  size?: number;
}) {
  const body = variant === "dark" ? "#F5F1EA" : "#1B3139";
  const eye = variant === "dark" ? "#1B3139" : "#F5F1EA";
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label="ktx mascot"
    >
      <g fill="none" stroke={body} strokeWidth="16" strokeLinecap="round">
        <path d="M 62 110 Q 32 130 44 152" />
        <path d="M 88 116 Q 80 152 70 174" />
        <path d="M 112 116 Q 120 152 130 174" />
      </g>
      <path
        d="M 134 108 C 162 116, 172 96, 162 78 C 154 64, 168 56, 178 60"
        fill="none"
        stroke="#FF8A4C"
        strokeWidth="16"
        strokeLinecap="round"
      />
      <path
        d="M 48 102 C 48 56, 78 30, 100 30 C 122 30, 152 56, 152 102 C 152 116, 132 120, 100 120 C 68 120, 48 116, 48 102 Z"
        fill={body}
      />
      <path
        d="M 80 84 Q 86 77 92 84"
        fill="none"
        stroke={eye}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        d="M 108 84 Q 114 77 120 84"
        fill="none"
        stroke={eye}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
