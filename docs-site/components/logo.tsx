export function Logo() {
  return (
    <div className="flex items-center gap-2 group">
      <div className="relative flex items-center justify-center transition-transform duration-300 ease-out group-hover:rotate-[-4deg]">
        <img
          src="/brand/ktx-mascot.png"
          alt=""
          aria-hidden="true"
          className="h-8 w-8 object-contain"
        />
      </div>
      <span
        className="text-[15px] font-semibold text-fd-foreground tracking-tight"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        KTX
      </span>
      <span
        className="text-[13px] font-medium text-fd-muted-foreground/80 tracking-tight border-l border-fd-border pl-2 ml-0.5"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        Docs
      </span>
    </div>
  );
}
