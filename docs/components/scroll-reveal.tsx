"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  stagger?: boolean;
  threshold?: number;
};

export function ScrollReveal({
  children,
  className = "",
  stagger = false,
  threshold = 0.1,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            if (stagger) {
              entry.target.querySelectorAll(".rv").forEach((el) => {
                el.classList.add("visible");
              });
            }
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold, rootMargin: "0px 0px -40px 0px" }
    );

    if (stagger) {
      observer.observe(node);
    } else {
      node.querySelectorAll(".rv").forEach((el) => observer.observe(el));
    }

    return () => observer.disconnect();
  }, [stagger, threshold]);

  return (
    <div
      ref={ref}
      className={`${stagger ? "rv rv-stagger" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
