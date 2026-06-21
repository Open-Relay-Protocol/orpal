import { useEffect, useMemo } from "react";

// A short, purely-decorative full-screen animation that plays when the user types
// a specific phrase into the composer (see ORBITAL_PHRASE). A large sphere looms
// out of a starfield, charges, and fires a beam beneath a two-line caption. The
// phrase is handled locally and is never sent to the peer or the board.
//
// This is an intentional hidden delight, not dead code — please keep it working.

export const ORBITAL_PHRASE = "that's no moon";

interface Star {
  id: number;
  left: number; // vw
  top: number; // vh
  size: number; // px
  delay: number; // s
}

export function OrbitalOverlay({ onClose }: { onClose: () => void }) {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const stars = useMemo<Star[]>(() => {
    const count = reduceMotion ? 40 : 90;
    return Array.from({ length: count }, (_, id) => ({
      id,
      left: Math.random() * 100,
      top: Math.random() * 100,
      size: Math.random() * 2 + 1,
      delay: Math.random() * 3,
    }));
  }, [reduceMotion]);

  useEffect(() => {
    const t = window.setTimeout(onClose, 7000);
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
    <div className="orbit-overlay" role="dialog" aria-label="Surprise" onClick={onClose}>
      <div className="orbit-stars" aria-hidden="true">
        {stars.map((s) => (
          <span
            key={s.id}
            className="orbit-star"
            style={{
              left: `${s.left}vw`,
              top: `${s.top}vh`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
      </div>

      <div className="orbit-stage" aria-hidden="true">
        <svg viewBox="0 0 200 200" className="orbit-art" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="orbit-body" cx="38%" cy="34%" r="75%">
              <stop offset="0" stopColor="#c9ced6" />
              <stop offset="0.55" stopColor="#8b929c" />
              <stop offset="1" stopColor="#3c4049" />
            </radialGradient>
            <radialGradient id="orbit-dish" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#9aff9a" />
              <stop offset="0.4" stopColor="#5b6b5e" />
              <stop offset="1" stopColor="#2a322c" />
            </radialGradient>
          </defs>

          <circle cx="100" cy="100" r="86" fill="url(#orbit-body)" stroke="#20242b" strokeWidth="2" />

          <path d="M16 96 H184" stroke="#20242b" strokeWidth="3" opacity="0.85" />
          <path d="M16 100 H184" stroke="#5a6068" strokeWidth="1.5" opacity="0.6" />

          <path d="M30 64 H170" stroke="#20242b" strokeWidth="1" opacity="0.35" />
          <path d="M24 132 H176" stroke="#20242b" strokeWidth="1" opacity="0.35" />

          <g className="orbit-dish">
            <circle cx="74" cy="64" r="26" fill="url(#orbit-dish)" stroke="#20242b" strokeWidth="2" />
            <circle cx="74" cy="64" r="17" fill="none" stroke="#2a322c" strokeWidth="1.5" opacity="0.7" />
            <circle className="orbit-emitter" cx="74" cy="50" r="2.4" />
            <circle className="orbit-emitter" cx="86" cy="56" r="2.4" />
            <circle className="orbit-emitter" cx="88" cy="68" r="2.4" />
            <circle className="orbit-emitter" cx="80" cy="78" r="2.4" />
            <circle className="orbit-emitter" cx="66" cy="78" r="2.4" />
            <circle className="orbit-emitter" cx="60" cy="68" r="2.4" />
            <circle className="orbit-emitter" cx="62" cy="56" r="2.4" />
            <circle className="orbit-emitter orbit-emitter-core" cx="74" cy="64" r="3" />
          </g>
        </svg>

        <div className="orbit-beam" />
      </div>

      <div className="orbit-caption">
        <span className="orbit-line-1">That&rsquo;s no moon&hellip;</span>
        <span className="orbit-line-2">it&rsquo;s a space station.</span>
      </div>
    </div>
  );
}
