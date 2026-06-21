import { useEffect, useRef, useState } from "react";
import type { BrokerState } from "../state/orpal-context.js";
import type { SkinId } from "../orpal/skins.js";

// ORPAL-019: a crafted LCD/CRT-style signal meter for the sidebar header. It
// replaces the static equalizer-bar icon with a small canvas spectrum that
// reflects real board state -- a calm pulse while connected, a sweep while
// connecting, a low red floor when down -- and ticks up briefly on message
// activity. It's a few bars on a canvas (no deps), reads its palette from the
// active skin's CSS tokens, idles its animation loop when there's nothing to
// show, and falls back to a single static frame under prefers-reduced-motion.

const NBARS = 7;

interface Palette {
  bg: string;
  lcd: string;
  dim: string;
  tip: string;
  warn: string;
  err: string;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--lcd-bg", "#03101f"),
    lcd: v("--lcd", "#4fa0ff"),
    dim: v("--lcd-dim", "#1f5bbf"),
    tip: v("--eq-tip", "#cfe6ff"),
    warn: v("--warn", "#ffcf3a"),
    err: v("--err", "#ff5a48"),
  };
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** Resting "signal strength" for a board state -- the baseline the bars hover at. */
function baseEnergy(state: BrokerState): number {
  switch (state) {
    case "open":
      return 0.42;
    case "connecting":
      return 0.3;
    default:
      return 0.05; // closed / error -- a quiet red floor
  }
}

function barLabel(state: BrokerState): string {
  switch (state) {
    case "open":
      return "Board signal: connected";
    case "connecting":
      return "Board signal: connecting";
    case "closed":
      return "Board signal: disconnected";
    default:
      return "Board signal: error";
  }
}

export function SignalMeter({
  state,
  activity,
  skin,
}: {
  state: BrokerState;
  activity: number;
  skin: SkinId;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const reduce = usePrefersReducedMotion();

  const paletteRef = useRef<Palette>(readPalette());
  const heightsRef = useRef<number[]>(Array.from({ length: NBARS }, () => 0.12));
  const pulseRef = useRef(0);
  const dimsRef = useRef({ w: 64, h: 20, dpr: 1 });
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  // Hold the latest draw/loop fns in refs so the palette/state/activity effects
  // can poke them without re-subscribing the whole animation loop.
  const drawRef = useRef<(() => void) | null>(null);
  const startRef = useRef<(() => void) | null>(null);

  // Re-read the palette whenever the skin changes so the meter matches the theme.
  useEffect(() => {
    paletteRef.current = readPalette();
    drawRef.current?.();
  }, [skin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const setup = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || 64));
      const h = Math.max(1, Math.round(rect.height || 20));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      dimsRef.current = { w, h, dpr };
    };

    const draw = (animated: boolean) => {
      const { w, h, dpr } = dimsRef.current;
      const p = paletteRef.current;
      const st = stateRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, w, h);

      const energy = Math.min(1, baseEnergy(st) + pulseRef.current);
      const t = performance.now() / 1000;
      const heights = heightsRef.current;
      for (let i = 0; i < NBARS; i++) {
        let wob: number;
        if (!animated) {
          // Static frame: a gentle deterministic arch, no time term.
          wob = 0.5 + 0.4 * Math.sin((i / (NBARS - 1)) * Math.PI);
        } else if (st === "connecting") {
          wob = (Math.sin(t * 1.7 - i * 0.6) + 1) / 2; // a peak sweeping across
        } else {
          wob = (Math.sin(t * (1.25 + i * 0.27) + i) + 1) / 2;
        }
        const target = 0.12 + energy * (0.22 + 0.78 * wob);
        heights[i] = animated ? heights[i] + (target - heights[i]) * 0.25 : target;
      }

      const pad = 3;
      const gap = 2;
      const usableW = w - pad * 2;
      const barW = (usableW - gap * (NBARS - 1)) / NBARS;
      for (let i = 0; i < NBARS; i++) {
        const bh = Math.max(2, heights[i] * (h - pad * 2));
        const x = pad + i * (barW + gap);
        const y = h - pad - bh;
        let glow: string;
        if (st === "open") {
          const grad = ctx.createLinearGradient(0, h - pad, 0, pad);
          grad.addColorStop(0, p.dim);
          grad.addColorStop(0.55, p.lcd);
          grad.addColorStop(1, p.tip);
          ctx.fillStyle = grad;
          glow = p.lcd;
        } else if (st === "connecting") {
          ctx.fillStyle = p.warn;
          glow = p.warn;
        } else {
          ctx.fillStyle = p.err;
          glow = p.err;
        }
        ctx.shadowColor = glow; // a string -- a gradient can't be a shadow colour
        ctx.shadowBlur = st === "open" ? 4 : 3;
        ctx.fillRect(x, y, barW, bh);
      }
      ctx.shadowBlur = 0;
    };

    drawRef.current = () => draw(!reduce ? true : false);

    const shouldAnimate = () =>
      stateRef.current === "open" || stateRef.current === "connecting" || pulseRef.current > 0.01;

    const frame = () => {
      draw(true);
      pulseRef.current *= 0.92;
      if (shouldAnimate()) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        runningRef.current = false;
        draw(true); // settle one last frame at the resting floor
      }
    };

    const start = () => {
      if (runningRef.current || reduce) return;
      runningRef.current = true;
      rafRef.current = requestAnimationFrame(frame);
    };
    startRef.current = start;

    setup();
    const onResize = () => {
      setup();
      draw(!reduce);
    };
    window.addEventListener("resize", onResize);

    if (reduce) draw(false);
    else start();

    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
    };
  }, [reduce]);

  // State changed: restart the loop (or redraw the static frame).
  useEffect(() => {
    if (reduce) drawRef.current?.();
    else startRef.current?.();
  }, [state, reduce]);

  // Message activity: inject a brief energy spike and make sure the loop runs.
  useEffect(() => {
    if (activity === 0) return;
    pulseRef.current = Math.min(1, pulseRef.current + 0.55);
    if (!reduce) startRef.current?.();
  }, [activity, reduce]);

  return (
    <div className="signal" role="img" aria-label={barLabel(state)} title={barLabel(state)}>
      <canvas ref={canvasRef} className="signal-canvas" />
    </div>
  );
}
