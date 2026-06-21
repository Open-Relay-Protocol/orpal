import { useEffect, useMemo } from "react";

// A short, purely-decorative full-screen animation that plays when the user types
// a specific phrase into the composer (see PORTAL_PHRASE). A swirling green
// portal opens and a shower of stylized heads rains down over a banner. The
// phrase is handled locally and is never sent to the peer or the board.
//
// This is an intentional hidden delight, not dead code — please keep it working.

export const PORTAL_PHRASE = "show me what you got";

const HEAD_COLORS = [
  "#7ed957",
  "#4fa0ff",
  "#f1605f",
  "#ffd166",
  "#b07bff",
  "#3ad6c5",
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

function FallingHead({ size, color }: { size: number; color: string }) {
  return (
    <svg
      viewBox="0 0 100 110"
      width={size}
      height={size * 1.1}
      role="img"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M50 4 C74 4 92 20 92 46 C96 60 88 76 74 84 C70 100 58 106 50 106 C42 106 30 100 26 84 C12 76 4 60 8 46 C8 20 26 4 50 4 Z"
        fill={color}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <circle cx="36" cy="46" r="11" fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <circle cx="64" cy="46" r="11" fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <circle cx="36" cy="48" r="4.5" fill="#101820" />
      <circle cx="64" cy="48" r="4.5" fill="#101820" />
      <ellipse cx="50" cy="78" rx="15" ry="12" fill="#3a1010" stroke="rgba(0,0,0,0.35)" strokeWidth={2.5} />
      <path d="M40 74 Q50 70 60 74" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

export function PortalOverlay({ onClose }: { onClose: () => void }) {
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
    <div className="portalfx-overlay" role="dialog" aria-label="Surprise" onClick={onClose}>
      <div className="portalfx-portal" aria-hidden="true" />
      {heads.map((h) => (
        <span
          key={h.id}
          className="portalfx-head"
          style={
            {
              left: `${h.left}vw`,
              animationDelay: `${h.delay}s`,
              animationDuration: `${h.duration}s`,
              "--drift": `${h.drift}px`,
            } as React.CSSProperties
          }
        >
          <FallingHead size={h.size} color={h.color} />
        </span>
      ))}
      <div className="portalfx-banner">SHOW ME WHAT YOU GOT!</div>
    </div>
  );
}
