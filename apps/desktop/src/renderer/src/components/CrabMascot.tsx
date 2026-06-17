import { useEffect, useId, useRef, useState } from "react";

// The ORP crab mascot, drawn inline so it can come alive:
//   * eyes track the cursor and the whole crab tilts slightly toward it,
//   * the claws and the eight legs gently dangle/sway (CSS animations),
//   * the body is BLUE when the connection is secure and RED while connecting
//     or disconnected.
// Shape follows the brand art: a wide rounded carapace with small shoulder
// spikes, eyebrows, antennae, cracked closed pincers, and the ORP shield.

export type CrabStatus = "secure" | "connecting" | "down";

const PALETTE: Record<CrabStatus, { g1: string; g2: string; out: string }> = {
  secure: { g1: "#3f8bf2", g2: "#2462cc", out: "#173f86" },
  connecting: { g1: "#f1605f", g2: "#c52f2f", out: "#7c1d1d" },
  down: { g1: "#ef5350", g2: "#b02323", out: "#6f1a1a" },
};

interface LegDef {
  attach: [number, number];
  knee: [number, number];
  foot: [number, number];
}

// 4 legs per side, attaching along the lower body and fanning down/out.
const LEFT_LEGS: LegDef[] = [
  { attach: [80, 150], knee: [54, 154], foot: [44, 172] },
  { attach: [82, 162], knee: [52, 168], foot: [42, 188] },
  { attach: [86, 173], knee: [56, 182], foot: [48, 202] },
  { attach: [92, 182], knee: [66, 194], foot: [58, 214] },
];
const RIGHT_LEGS: LegDef[] = LEFT_LEGS.map((l) => ({
  attach: [280 - l.attach[0], l.attach[1]],
  knee: [280 - l.knee[0], l.knee[1]],
  foot: [280 - l.foot[0], l.foot[1]],
}));

export function CrabMascot({
  className,
  status = "secure",
}: {
  className?: string;
  status?: CrabStatus;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const gradId = useId().replace(/:/g, "");
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
      const cy = r.top + r.height * 0.46;
      const nx = (pending.x - cx) / (r.width * 0.6);
      const ny = (pending.y - cy) / (r.height * 0.6);
      setLook({ x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) });
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

  const c = PALETTE[status];
  const pdx = look.x * 5;
  const pdy = look.y * 4;
  const tilt = look.x * 4;

  const legGroup = (legs: LegDef[], side: string) =>
    legs.map((l, i) => (
      <g
        key={`${side}${i}`}
        className="crab-leg"
        style={{
          transformBox: "view-box",
          transformOrigin: `${l.attach[0]}px ${l.attach[1]}px`,
          animationDelay: `${(side === "L" ? i : i + 0.5) * 0.22}s`,
        }}
      >
        <path
          d={`M${l.attach[0]} ${l.attach[1]} L${l.knee[0]} ${l.knee[1]} L${l.foot[0]} ${l.foot[1]}`}
          fill="none"
          stroke={c.out}
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={`M${l.attach[0]} ${l.attach[1]} L${l.knee[0]} ${l.knee[1]} L${l.foot[0]} ${l.foot[1]}`}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={6.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={l.knee[0]} cy={l.knee[1]} r={3.4} fill={`url(#${gradId})`} stroke={c.out} strokeWidth={2} />
      </g>
    ));

  return (
    <svg
      ref={ref}
      viewBox="0 0 280 232"
      className={`${className ?? ""} ${status === "secure" ? "" : "crab-connecting"}`.trim()}
      role="img"
      aria-label="ORP crab mascot"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.g1} />
          <stop offset="1" stopColor={c.g2} />
        </linearGradient>
      </defs>

      <g style={{ transformBox: "view-box", transformOrigin: "140px 120px", transform: `rotate(${tilt}deg)`, transition: "transform 0.18s ease-out" }}>
        {/* legs (behind body) */}
        {legGroup(LEFT_LEGS, "L")}
        {legGroup(RIGHT_LEGS, "R")}

        {/* claws (each sways as one piece) */}
        <g className="crab-claw" style={{ transformBox: "view-box", transformOrigin: "66px 112px" }}>
          <path d="M66 112 L46 98 L36 76" fill="none" stroke={c.out} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M66 112 L46 98 L36 76" fill="none" stroke={`url(#${gradId})`} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
          <ellipse cx="30" cy="54" rx="20" ry="14" transform="rotate(-22 30 54)" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />
          <ellipse cx="41" cy="70" rx="13" ry="9" transform="rotate(-6 41 70)" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />
          <path d="M16 48 l6 4 l-4 4 l6 3" fill="none" stroke={c.out} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <g className="crab-claw" style={{ transformBox: "view-box", transformOrigin: "214px 112px", animationDelay: "-1.1s" }}>
          <path d="M214 112 L234 98 L244 76" fill="none" stroke={c.out} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M214 112 L234 98 L244 76" fill="none" stroke={`url(#${gradId})`} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
          <ellipse cx="250" cy="54" rx="20" ry="14" transform="rotate(22 250 54)" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />
          <ellipse cx="239" cy="70" rx="13" ry="9" transform="rotate(6 239 70)" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />
          <path d="M264 48 l-6 4 l4 4 l-6 3" fill="none" stroke={c.out} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {/* antennae */}
        <path d="M124 50 L122 32" fill="none" stroke={c.out} strokeWidth={6} strokeLinecap="round" />
        <path d="M156 50 L158 32" fill="none" stroke={c.out} strokeWidth={6} strokeLinecap="round" />
        <circle cx="121" cy="28" r="6" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />
        <circle cx="159" cy="28" r="6" fill={`url(#${gradId})`} stroke={c.out} strokeWidth={4} />

        {/* carapace: wide, rounded, small shoulder spikes, soft bottom point */}
        <path
          d="M60 120 C56 88 64 64 84 54 L92 46 L100 53 L108 46 L116 52 C124 48 132 47 140 47 C148 47 156 48 164 52 L172 46 L180 53 L188 46 L196 54 C216 64 224 88 220 120 C224 156 194 198 140 206 C86 198 56 156 60 120 Z"
          fill={`url(#${gradId})`}
          stroke={c.out}
          strokeWidth={5}
          strokeLinejoin="round"
        />

        {/* shield on the belly (brand navy regardless of status) */}
        <path
          d="M112 118 L168 118 L168 144 C168 164 140 176 140 176 C140 176 112 164 112 144 Z"
          fill="#163f86"
          stroke="#ffffff"
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <text x="140" y="145" textAnchor="middle" dominantBaseline="central" fontFamily="'Arial Black',Arial,sans-serif" fontWeight="900" fontSize="21" letterSpacing="1" fill="#ffffff">
          ORP
        </text>

        {/* eyebrows */}
        <path d="M102 76 Q118 69 134 76" fill="none" stroke={c.out} strokeWidth={3.5} strokeLinecap="round" />
        <path d="M146 76 Q162 69 178 76" fill="none" stroke={c.out} strokeWidth={3.5} strokeLinecap="round" />

        {/* eyes — pupils track the cursor */}
        <circle cx="118" cy="96" r="16" fill="#ffffff" stroke={c.out} strokeWidth={3} />
        <circle cx="162" cy="96" r="16" fill="#ffffff" stroke={c.out} strokeWidth={3} />
        <circle cx={118 + pdx} cy={96 + pdy} r="7" fill="#0c2f6b" />
        <circle cx={162 + pdx} cy={96 + pdy} r="7" fill="#0c2f6b" />
        <circle cx={120 + pdx} cy={93 + pdy} r="2.4" fill="#ffffff" />
        <circle cx={164 + pdx} cy={93 + pdy} r="2.4" fill="#ffffff" />

        {/* smile */}
        <path d="M130 116 Q140 127 150 116" fill="none" stroke={c.out} strokeWidth={4} strokeLinecap="round" />
      </g>
    </svg>
  );
}
