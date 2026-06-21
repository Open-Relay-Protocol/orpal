import { useEffect, useMemo } from "react";

// 🌑 Easter egg: type "that's no moon" into any conversation and a Death Star
// looms out of the starfield, charges its superlaser, and fires — "That's no
// moon... it's a space station." Purely local; nothing is sent to your peer or
// the board.

export const DEATH_STAR_PHRASE = "that's no moon";

interface Star {
  id: number;
  left: number; // vw
  top: number; // vh
  size: number; // px
  delay: number; // s
}

export function DeathStarEasterEgg({ onClose }: { onClose: () => void }) {
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
    <div
      className="deathstar-overlay"
      role="dialog"
      aria-label="That's no moon"
      onClick={onClose}
    >
      <div className="deathstar-stars" aria-hidden="true">
        {stars.map((s) => (
          <span
            key={s.id}
            className="deathstar-star"
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

      <div className="deathstar-stage" aria-hidden="true">
        <svg viewBox="0 0 200 200" className="deathstar-art" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="ds-body" cx="38%" cy="34%" r="75%">
              <stop offset="0" stopColor="#c9ced6" />
              <stop offset="0.55" stopColor="#8b929c" />
              <stop offset="1" stopColor="#3c4049" />
            </radialGradient>
            <radialGradient id="ds-dish" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#9aff9a" />
              <stop offset="0.4" stopColor="#5b6b5e" />
              <stop offset="1" stopColor="#2a322c" />
            </radialGradient>
          </defs>

          {/* sphere */}
          <circle cx="100" cy="100" r="86" fill="url(#ds-body)" stroke="#20242b" strokeWidth="2" />

          {/* equatorial trench */}
          <path d="M16 96 H184" stroke="#20242b" strokeWidth="3" opacity="0.85" />
          <path d="M16 100 H184" stroke="#5a6068" strokeWidth="1.5" opacity="0.6" />

          {/* a few surface latitude/longitude hints */}
          <path d="M30 64 H170" stroke="#20242b" strokeWidth="1" opacity="0.35" />
          <path d="M24 132 H176" stroke="#20242b" strokeWidth="1" opacity="0.35" />

          {/* the superlaser dish */}
          <g className="deathstar-dish">
            <circle cx="74" cy="64" r="26" fill="url(#ds-dish)" stroke="#20242b" strokeWidth="2" />
            <circle cx="74" cy="64" r="17" fill="none" stroke="#2a322c" strokeWidth="1.5" opacity="0.7" />
            {/* the eight emitters */}
            <circle className="deathstar-emitter" cx="74" cy="50" r="2.4" />
            <circle className="deathstar-emitter" cx="86" cy="56" r="2.4" />
            <circle className="deathstar-emitter" cx="88" cy="68" r="2.4" />
            <circle className="deathstar-emitter" cx="80" cy="78" r="2.4" />
            <circle className="deathstar-emitter" cx="66" cy="78" r="2.4" />
            <circle className="deathstar-emitter" cx="60" cy="68" r="2.4" />
            <circle className="deathstar-emitter" cx="62" cy="56" r="2.4" />
            <circle className="deathstar-emitter deathstar-emitter-core" cx="74" cy="64" r="3" />
          </g>
        </svg>

        {/* the superlaser beam, fired downward off the dish */}
        <div className="deathstar-beam" />
      </div>

      <div className="deathstar-caption">
        <span className="deathstar-line-1">That&rsquo;s no moon&hellip;</span>
        <span className="deathstar-line-2">it&rsquo;s a space station.</span>
      </div>
    </div>
  );
}
