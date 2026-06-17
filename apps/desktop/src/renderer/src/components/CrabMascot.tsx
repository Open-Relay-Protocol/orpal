import { useEffect, useRef, useState } from "react";

// The ORP crab mascot, drawn inline so it can come alive: the eyes track the
// cursor and the whole crab tilts slightly toward it. Wider serrated carapace,
// big friendly eyes, raised cracked pincers, eight legs, and the ORP shield —
// closer to the brand art than a static teardrop.

export function CrabMascot({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });

  useEffect(() => {
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const apply = () => {
      raf = 0;
      const el = ref.current;
      if (!el || !pending) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.46; // the face sits a little above center
      const nx = (pending.x - cx) / (r.width * 0.6);
      const ny = (pending.y - cy) / (r.height * 0.6);
      setLook({
        x: Math.max(-1, Math.min(1, nx)),
        y: Math.max(-1, Math.min(1, ny)),
      });
    };
    const onMove = (e: MouseEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const pdx = look.x * 5;
  const pdy = look.y * 4;
  const tilt = look.x * 4;

  return (
    <svg
      ref={ref}
      viewBox="0 0 280 212"
      className={className}
      role="img"
      aria-label="ORP crab mascot"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="crabBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f8bf2" />
          <stop offset="1" stopColor="#2462cc" />
        </linearGradient>
      </defs>

      <g
        style={{
          transformOrigin: "140px 120px",
          transform: `rotate(${tilt}deg)`,
          transition: "transform 0.18s ease-out",
        }}
      >
        {/* legs + arms (behind the body) */}
        <g
          fill="none"
          stroke="#173f86"
          strokeWidth={13}
          strokeLinecap="round"
        >
          <path d="M84 148 Q50 146 28 130" />
          <path d="M84 157 Q46 165 24 160" />
          <path d="M88 166 Q50 183 32 189" />
          <path d="M95 174 Q64 195 50 201" />
          <path d="M196 148 Q230 146 252 130" />
          <path d="M196 157 Q234 165 256 160" />
          <path d="M192 166 Q230 183 248 189" />
          <path d="M185 174 Q216 195 230 201" />
        </g>
        <g fill="none" stroke="#173f86" strokeWidth={13} strokeLinecap="round">
          <path d="M70 104 Q44 96 34 70" />
          <path d="M210 104 Q236 96 246 70" />
        </g>
        <g fill="url(#crabBody)" stroke="#173f86" strokeWidth={8} strokeLinecap="round">
          <path d="M70 104 Q44 96 34 70" />
          <path d="M210 104 Q236 96 246 70" />
        </g>

        {/* claws */}
        <g fill="url(#crabBody)" stroke="#173f86" strokeWidth={4} strokeLinejoin="round">
          <ellipse cx="30" cy="52" rx="21" ry="14" transform="rotate(-22 30 52)" />
          <ellipse cx="41" cy="69" rx="13" ry="9" transform="rotate(-6 41 69)" />
          <ellipse cx="250" cy="52" rx="21" ry="14" transform="rotate(22 250 52)" />
          <ellipse cx="239" cy="69" rx="13" ry="9" transform="rotate(6 239 69)" />
        </g>
        {/* claw cracks */}
        <g fill="none" stroke="#173f86" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 46 l6 4 l-4 4 l6 3" />
          <path d="M258 46 l-6 4 l4 4 l-6 3" />
        </g>

        {/* antennae */}
        <g stroke="#173f86" strokeWidth={6} strokeLinecap="round">
          <path d="M124 58 L122 42" fill="none" />
          <path d="M156 58 L158 42" fill="none" />
        </g>
        <g fill="url(#crabBody)" stroke="#173f86" strokeWidth={4}>
          <circle cx="121" cy="38" r="6" />
          <circle cx="159" cy="38" r="6" />
        </g>

        {/* serrated carapace */}
        <path
          d="M64 96 L74 74 L88 82 L102 64 L116 70 L130 55 L140 58 L150 55 L164 70 L178 64 L192 82 L206 74 L216 96 C214 130 185 170 140 182 C95 170 66 130 64 96 Z"
          fill="url(#crabBody)"
          stroke="#173f86"
          strokeWidth={5}
          strokeLinejoin="round"
        />

        {/* shield on the belly */}
        <path
          d="M112 116 L168 116 L168 142 C168 162 140 174 140 174 C140 174 112 162 112 142 Z"
          fill="#163f86"
          stroke="#ffffff"
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <text
          x="140"
          y="143"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Arial Black',Arial,sans-serif"
          fontWeight="900"
          fontSize="21"
          letterSpacing="1"
          fill="#ffffff"
        >
          ORP
        </text>

        {/* face — eyes track the cursor */}
        <circle cx="118" cy="94" r="16" fill="#ffffff" stroke="#173f86" strokeWidth={3} />
        <circle cx="162" cy="94" r="16" fill="#ffffff" stroke="#173f86" strokeWidth={3} />
        <circle cx={118 + pdx} cy={94 + pdy} r="7" fill="#0c2f6b" />
        <circle cx={162 + pdx} cy={94 + pdy} r="7" fill="#0c2f6b" />
        <circle cx={120 + pdx} cy={91 + pdy} r="2.4" fill="#ffffff" />
        <circle cx={164 + pdx} cy={91 + pdy} r="2.4" fill="#ffffff" />
        <path
          d="M128 114 Q140 126 152 114"
          fill="none"
          stroke="#173f86"
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
