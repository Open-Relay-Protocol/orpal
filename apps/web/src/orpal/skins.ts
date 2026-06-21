// ORPAL-019: customizable "skins" -- a skin is just a swapped set of CSS custom
// properties (see the [data-skin=…] blocks in styles.css). Every skin stays
// faithful to Orpal's Winamp/retro identity: chunky beveled chrome, an LCD-style
// readout, monospace accents. The selection lives in localStorage so it survives
// restarts and can be applied synchronously at boot (no theme flash).

export type SkinId = "steel" | "amber" | "night" | "phosphor" | "synthwave" | "grey";

export interface Skin {
  id: SkinId;
  /** Shown in the Settings picker. */
  name: string;
  /** A one-line flavour description. */
  blurb: string;
  /** Preview swatch colours for the picker chip (chrome panel + LCD/accent). */
  swatch: { bg: string; chrome: string; accent: string };
}

export const SKINS: readonly Skin[] = [
  {
    id: "steel",
    name: "Steel Blue",
    blurb: "The classic ORP cobalt — gunmetal bevels and a blue LCD.",
    swatch: { bg: "#131722", chrome: "#283044", accent: "#4fa0ff" },
  },
  {
    id: "amber",
    name: "Amber CRT",
    blurb: "Warm amber phosphor glowing on a dark vintage terminal.",
    swatch: { bg: "#0d0a04", chrome: "#332a1c", accent: "#ffb347" },
  },
  {
    id: "night",
    name: "Night",
    blurb: "OLED black with a cool cyan readout — easy on the eyes.",
    swatch: { bg: "#000000", chrome: "#0c0c0c", accent: "#5ad6ff" },
  },
  {
    id: "phosphor",
    name: "Green Phosphor",
    blurb: "Monochrome green terminal, straight off an old CRT.",
    swatch: { bg: "#010a05", chrome: "#0f2417", accent: "#33ff66" },
  },
  {
    id: "synthwave",
    name: "Magenta Synthwave",
    blurb: "Neon magenta on deep violet — after-dark arcade glow.",
    swatch: { bg: "#0d0418", chrome: "#2a1840", accent: "#ff6ec7" },
  },
  {
    id: "grey",
    name: "Classic Grey",
    blurb: "Win95 chrome — light grey bevels, navy titlebars.",
    swatch: { bg: "#0a5a5a", chrome: "#c0c0c0", accent: "#2bd957" },
  },
];

export const DEFAULT_SKIN: SkinId = "steel";

const SKIN_LS = "orpal:skin";

export function isSkinId(v: unknown): v is SkinId {
  return typeof v === "string" && SKINS.some((s) => s.id === v);
}

/** Read the persisted skin (defaults to Steel Blue). Safe to call before React. */
export function loadSkin(): SkinId {
  try {
    const raw = localStorage.getItem(SKIN_LS);
    return isSkinId(raw) ? raw : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Reflect a skin onto the document so the CSS token block takes effect. */
export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
}

/** Persist the chosen skin so it survives a restart. */
export function persistSkin(id: SkinId): void {
  try {
    localStorage.setItem(SKIN_LS, id);
  } catch {
    /* storage full / disabled -- the skin still applies for this session */
  }
}
