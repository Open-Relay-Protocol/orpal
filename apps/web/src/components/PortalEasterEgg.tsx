import { useEffect, useMemo } from "react";

// 🥒 Easter egg: type "show me what you got" into any conversation and the
// Cromulons descend, Get-Schwifty style. A swirling green portal opens and a
// shower of giant floating heads rains down chanting "SHOW ME WHAT YOU GOT!".
// Purely local — nothing is ever sent to your peer or the board.

export const EASTER_EGG_PHRASE = "show me what you got";

const HEAD_COLORS = [
  "#7ed957", // portal green
  "#4fa0ff", // orp blue
  "#f1605f", // crab red
  "#ffd166", // amber
  "#b07bff", // purple
  "#3ad6c5", // teal
];

interface Head {
  id: number;
  left: number; // vw
  size: number; // px
  delay: number; // s
  duration: number; // s
  drift: number; // px
  color: string;
}

function CromulonHead({ size, color }: { size: number; color: string }) {
  return (
    <svg
      viewBox="0 0 100 110"
      width={size}
      height={size * 1.1}
      role="img"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* lumpy floating head */}
      <path
        d="M50 4 C74 4 92 20 92 46 C96 60 88 76 74 84 C70 100 58 106 50 106 C42 106 30 100 26 84 C12 76 4 60 8 46 C8 20 26 4 50 4 Z"
        fill={color}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {/* eyes */}
      <circle cx="36" cy="46" r="11" fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <circle cx="64" cy="46" r="11" fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <circle cx="36" cy="48" r="4.5" fill="#101820" />
      <circle cx="64" cy="48" r="4.5" fill="#101820" />
      {/* gaping, screaming mouth */}
      <ellipse cx="50" cy="78" rx="15" ry="12" fill="#3a1010" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <path d="M40 74 Q50 70 60 74" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

export function PortalEasterEgg({ onClose }: { onClose: () => void }) {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const heads = useMemo<Head[]>(() => {
    const count = reduceMotion ? 6 : 16;
    return Array.from({ length: count }, (_, id) => ({
      id,
      left: Math.random() * 92 + 2,
      size: Math.random() * 56 + 44,
      delay: Math.random() * 1.6,
      duration: Math.random() * 2.2 + 3.4,
      drift: (Math.random() - 0.5) * 120,
      color: HEAD_COLORS[id % HEAD_COLORS.length],
    }));
  }, [reduceMotion]);

  // Auto-dismiss; the show is short and sweet.
  useEffect(() => {
    const t = window.setTimeout(onClose, 6000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="schwifty-overlay"
      role="dialog"
      aria-label="Show me what you got!"
      onClick={onClose}
    >
      <div className="schwifty-portal" aria-hidden="true" />
      {heads.map((h) => (
        <span
          key={h.id}
          className="schwifty-head"
          style={
            {
              left: `${h.left}vw`,
              animationDelay: `${h.delay}s`,
              animationDuration: `${h.duration}s`,
              "--drift": `${h.drift}px`,
            } as React.CSSProperties
          }
        >
          <CromulonHead size={h.size} color={h.color} />
        </span>
      ))}
      <div className="schwifty-banner">SHOW ME WHAT YOU GOT!</div>
    </div>
  );
}
