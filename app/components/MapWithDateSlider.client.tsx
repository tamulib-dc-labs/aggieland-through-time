// @ts-nocheck — leaflet has no @types in this project; esbuild resolves it fine
import React, { useEffect, useRef, useMemo, useState } from "react";
import L from "leaflet";
import { WarpedMapLayer } from "@allmaps/leaflet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TileLayer = {
  name: string;
  url: string;
  attribution: string;
  maxZoom?: number;
};

type GeorefAnnotation = {
  name: string;
  url: string; // Allmaps / IIIF Georeference Annotation URL
};

type NavManifest = {
  id: string;
  slug: string;
  href: string;
  title: string;
  thumbnail: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  features: { id: string; label: string; lat: number; lng: number }[];
};

type SearchRecord = { id: string; href: string };
type SearchIndexEntry = { id: string; metadata: string[] };

type EnrichedMarker = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  href: string;
  thumbnail: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  dateBuilt: number | null;
  dateRazed: number | null; // still-standing buildings use the current year, for filtering
  standing: boolean;
};

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let cssInjected = false;
let mcScriptPromise: Promise<void> | null = null;

function ensureLeafletCss(): void {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;

  const basePath = typeof window !== "undefined" ? ((window as any).CANOPY_BASE_PATH || "") : "";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${basePath}/scripts/canopy-map.css`;
  document.head.appendChild(link);

  // Dual-range slider: disable track click, re-enable on thumb only, custom thumb style
  const style = document.createElement("style");
  style.textContent = `
    .cdrs input[type=range] {
      -webkit-appearance: none; appearance: none;
      pointer-events: none;
      background: transparent;
      position: absolute; width: 100%; height: 20px; margin: 0; padding: 0;
    }
    .cdrs input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      pointer-events: all;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #500000;
      border: 2px solid #fff;
      cursor: pointer;
      box-shadow: 0 1px 5px rgba(0,0,0,.55);
    }
    .cdrs input[type=range]::-moz-range-thumb {
      pointer-events: all;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #500000;
      border: 2px solid #fff;
      cursor: pointer;
      box-shadow: 0 1px 5px rgba(0,0,0,.55);
    }
    .cdrs input[type=range]::-webkit-slider-runnable-track { background: transparent; }
    .cdrs input[type=range]::-moz-range-track { background: transparent; }

    /* Historic imagery opacity: the track fades from clear to maroon and the
       thumb is the inverse of the date thumbs, so the two read differently */
    .georef-opacity input[type=range] {
      -webkit-appearance: none; appearance: none;
      height: 8px; border-radius: 4px; margin: 0; cursor: pointer;
      background: linear-gradient(to right, rgba(80,0,0,.08), #500000);
      border: 1px solid rgba(80,0,0,.25);
    }
    .georef-opacity input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px; height: 16px; border-radius: 50%;
      background: #fff; border: 3px solid #500000;
      box-shadow: 0 1px 4px rgba(0,0,0,.35);
    }
    .georef-opacity input[type=range]::-moz-range-thumb {
      width: 16px; height: 16px; border-radius: 50%; box-sizing: border-box;
      background: #fff; border: 3px solid #500000;
      box-shadow: 0 1px 4px rgba(0,0,0,.35);
    }
    .georef-opacity input[type=range]::-moz-range-track { background: transparent; }
    .georef-opacity input[type=range]:focus-visible { outline: 2px solid #500000; outline-offset: 3px; }

    /* Building finder list */
    .building-finder input[type=search]:focus-visible { outline: 2px solid #500000; outline-offset: 1px; }
    .building-finder .bf-item {
      display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem;
      width: 100%; padding: 0.4rem 0.6rem; border: 0; border-top: 1px solid #f0ece6;
      background: transparent; font: inherit; font-size: 0.85rem; color: #000;
      text-align: left; cursor: pointer;
    }
    .building-finder .bf-item:hover, .building-finder .bf-item:focus-visible {
      background: #f5f1eb; color: #500000; outline: none;
    }
    .building-finder .bf-hidden { color: #666; }
    .building-finder .bf-years { flex-shrink: 0; font-size: 0.75rem; color: #666; }
  `;
  document.head.appendChild(style);
}

/**
 * Load leaflet.markercluster from CDN as a UMD script.
 * We assign our bundled L to window.L first so the plugin patches the same
 * instance we're using — not a separate Leaflet copy loaded by Canopy.
 */
function loadMarkerCluster(): Promise<void> {
  if (mcScriptPromise) return mcScriptPromise;
  mcScriptPromise = new Promise<void>((resolve) => {
    if (typeof window === "undefined") { resolve(); return; }
    // Ensure our L is the global target before the plugin loads
    (window as any).L = L;
    if ((L as any).markerClusterGroup) { resolve(); return; }
    const script = document.createElement("script");
    script.src =
      "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(script);
  });
  return mcScriptPromise;
}

// ---------------------------------------------------------------------------
// Full screen helpers
// ---------------------------------------------------------------------------

const EXPAND_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const COMPRESS_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 1v5H1M15 6h-5V1M10 15v-5h5M1 10h5v5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

// Cluster toggle icons show the action the button will take
const UNGROUP_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3" cy="3" r="2.25" fill="currentColor"/><circle cx="13" cy="5" r="2.25" fill="currentColor"/><circle cx="6" cy="13" r="2.25" fill="currentColor"/></svg>`;
const GROUP_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><text x="8" y="11" text-anchor="middle" font-size="8" font-weight="700" font-family="sans-serif" fill="#fff">3</text></svg>`;

function setClusterButtonState(btn: HTMLAnchorElement, clustered: boolean): void {
  const label = clustered ? "Ungroup markers" : "Group markers";
  btn.innerHTML = clustered ? UNGROUP_ICON : GROUP_ICON;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", String(!clustered));
}

// Georeferenced overlay toggle icons
const OVERLAY_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5 15 5.25 8 9 1 5.25Z" fill="currentColor"/><path d="M1 8.25 8 12l7-3.75M1 11.25 8 15l7-3.75" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;

function setOverlayButtonState(btn: HTMLAnchorElement, visible: boolean): void {
  const text = visible ? "Hide historic imagery" : "Show historic imagery";
  btn.title = text;
  btn.setAttribute("aria-label", text);
  btn.setAttribute("aria-pressed", String(visible));
  btn.style.color = visible ? "#fff" : "#500000";
  btn.style.background = visible ? "#500000" : "";
}

/**
 * Stand-in for a WarpedMapLayer that can be toggled from the layer switcher.
 * The Allmaps layer reloads its annotation every time it is added to a map,
 * so it is created once, on first show, and afterwards only its pane is
 * hidden or shown.
 */
const GeorefToggleLayer = L.Layer.extend({
  initialize(url: string, pane: string) {
    this._url = url;
    this._paneName = pane;
  },
  onAdd(map: L.Map) {
    if (!this._warped) {
      this._warped = new WarpedMapLayer(this._url, { pane: this._paneName });
      this._warped.addTo(map);
    }
    map.getPane(this._paneName).style.display = "";
  },
  onRemove(map: L.Map) {
    map.getPane(this._paneName).style.display = "none";
  },
});

function getFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  return document.fullscreenElement || (document as any).webkitFullscreenElement || null;
}

// iPhone Safari has no element Fullscreen API; there we fall back to a
// fixed-position overlay that covers the viewport.
function supportsNativeFullscreen(el: HTMLElement): boolean {
  return Boolean(el.requestFullscreen || (el as any).webkitRequestFullscreen);
}

// ---------------------------------------------------------------------------
// Click tracking
// ---------------------------------------------------------------------------

// GA4 rejects parameter values longer than 100 characters
function truncate(val: string, max = 100): string {
  return val.length > max ? `${val.slice(0, max - 1)}…` : val;
}

/**
 * Report a map interaction. Dispatches a `canopy-map:<name>` CustomEvent on
 * window (full detail) and, when Google Analytics is loaded, sends a GA4
 * event with the flat, length-limited parameters.
 */
function trackMapEvent(
  name: string,
  detail: Record<string, unknown>,
  gaParams: Record<string, string | number | boolean>
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(`canopy-map:${name}`, { detail }));
  const gtag = (window as any).gtag;
  if (typeof gtag === "function") gtag("event", `map_${name.replace(/-/g, "_")}`, gaParams);
}

function markerSummary(m: EnrichedMarker) {
  return {
    id: m.id,
    title: m.title,
    href: m.href,
    lat: m.lat,
    lng: m.lng,
    dateBuilt: m.dateBuilt,
    dateRazed: m.standing ? null : m.dateRazed,
    standing: m.standing,
  };
}

// ---------------------------------------------------------------------------
// Year helpers
// ---------------------------------------------------------------------------

// Still-standing buildings run to the current year
const CURRENT_YEAR = new Date().getFullYear();

function escapeHtml(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Shareable view state in the URL hash
//   #years=1876-1933&map=17/30.61500/-96.34100&overlays=66a196ddd627845c&base=2&opacity=60
// Overlays are keyed by the last segment of their annotation URL so links
// keep working if the list is reordered. Defaults are left out of the hash.
// ---------------------------------------------------------------------------

type HashState = {
  start?: number;
  end?: number;
  zoom?: number;
  lat?: number;
  lng?: number;
  overlays?: string[];
  base?: number;
  opacity?: number;
};

const LINK_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2L8 3.8M9.5 6.5a3 3 0 0 0-4.2 0L2.7 9.1a3 3 0 0 0 4.2 4.2L8 12.2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
const CHECK_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 8.5 6 12l7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function annotationKey(url: string): string {
  return url.split("/").filter(Boolean).pop() ?? url;
}

function readHash(): HashState {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const num = (v: string | undefined) => (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : undefined);
  const out: HashState = {};
  const years = p.get("years")?.match(/^(\d{4})-(\d{4})$/);
  if (years) {
    out.start = Number(years[1]);
    out.end = Number(years[2]);
  }
  const [z, lat, lng] = (p.get("map") ?? "").split("/").map((v) => num(v));
  if (z !== undefined && lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    Object.assign(out, { zoom: z, lat, lng });
  }
  const overlays = p.get("overlays");
  if (overlays) out.overlays = overlays.split(",").filter(Boolean);
  out.base = num(p.get("base") ?? undefined);
  const opacity = num(p.get("opacity") ?? undefined);
  if (opacity !== undefined) out.opacity = Math.min(100, Math.max(0, Math.round(opacity)));
  return out;
}

// Visually hidden text inside Leaflet's HTML strings
const SR_ONLY_INLINE =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

function yearsLabel(m: EnrichedMarker): string {
  if (m.dateBuilt === null) return "Date unknown";
  return `${m.dateBuilt} – ${m.standing ? "Present" : m.dateRazed}`;
}

function parseYear(val: string | null | undefined): number | null {
  if (!val) return null;
  const m = String(val).match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapWithDateSlider({
  height = "800px",
  cluster = true,
  maxClusterRadius = 20,
  disableClusteringAtZoom = 19,
  tileLayers,
  georefAnnotations,
  center,
  zoom,
}: {
  height?: string;
  /** Starting view; without it the map fits every building */
  center?: [number, number];
  zoom?: number;
  cluster?: boolean;
  maxClusterRadius?: number;
  disableClusteringAtZoom?: number;
  tileLayers?: TileLayer[];
  georefAnnotations?: GeorefAnnotation[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const clusterGroupRef = useRef<any>(null);
  const initialBoundsSetRef = useRef(false);

  const [markers, setMarkers] = useState<EnrichedMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [startYear, setStartYear] = useState<number | null>(null);
  const [endYear, setEndYear] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const [clustered, setClustered] = useState(true);
  // Historic imagery: whether any overlay is on, and its opacity (0–100)
  const [overlayVisible, setOverlayVisible] = useState(false);
  // The view the page was opened with (read once, before anything rewrites it)
  const initialHashRef = useRef<HashState | null>(null);
  if (initialHashRef.current === null) initialHashRef.current = readHash();
  const [overlayOpacity, setOverlayOpacity] = useState(initialHashRef.current.opacity ?? 100);
  const opacityRef = useRef(overlayOpacity);
  opacityRef.current = overlayOpacity;
  const georefPanesRef = useRef<string[]>([]);
  // For writing the hash: overlays by key, the current base layer, a debounce timer
  const georefByKeyRef = useRef<Map<string, L.Layer>>(new Map());
  const baseIndexRef = useRef(0);
  const hashTimerRef = useRef<number | null>(null);
  // Building finder: search text, list open, markers by id, and a building to
  // fly to once the markers are rebuilt (after the date range widens)
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const markerByIdRef = useRef<Map<string, any>>(new Map());
  const pendingFlyRef = useRef<string | null>(null);
  const clusterButtonRef = useRef<HTMLAnchorElement | null>(null);
  const toggleFullscreenRef = useRef<() => void>(() => {});
  const fullscreenButtonRef = useRef<HTMLAnchorElement | null>(null);
  // Current slider range, read by the marker click handlers
  const yearRangeRef = useRef<{ start: number | null; end: number | null }>({ start: null, end: null });
  yearRangeRef.current = { start: startYear, end: endYear };

  toggleFullscreenRef.current = () => {
    const root = rootRef.current;
    if (!root) return;
    if (pseudoFullscreen) {
      setPseudoFullscreen(false);
    } else if (getFullscreenElement()) {
      (document.exitFullscreen || (document as any).webkitExitFullscreen)?.call(document);
    } else if (supportsNativeFullscreen(root)) {
      // Embedded contexts (e.g. an iframe without allowfullscreen) reject the
      // request; use the overlay instead. Older webkit returns no promise.
      const req = (root.requestFullscreen || (root as any).webkitRequestFullscreen).call(root);
      req?.catch?.(() => setPseudoFullscreen(true));
    } else {
      setPseudoFullscreen(true);
    }
  };

  // ── 1. CSS + MarkerCluster ─────────────────────────────────────────────
  useEffect(() => {
    ensureLeafletCss();
    loadMarkerCluster().then(() => setMapReady(true));
  }, []);

  // ── 1b. Track full screen state ────────────────────────────────────────
  useEffect(() => {
    const onChange = () => {
      const active = getFullscreenElement() === rootRef.current;
      setFullscreen(active || pseudoFullscreen);
    };
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [pseudoFullscreen]);

  // Escape exits the overlay fallback (the browser handles it for native)
  useEffect(() => {
    if (!pseudoFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPseudoFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [pseudoFullscreen]);

  // Resize the map and update the button whenever full screen changes
  useEffect(() => {
    mapInstanceRef.current?.invalidateSize();
    const btn = fullscreenButtonRef.current;
    if (btn) {
      const label = fullscreen ? "Exit full screen" : "View full screen";
      btn.innerHTML = fullscreen ? COMPRESS_ICON : EXPAND_ICON;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("aria-pressed", String(fullscreen));
    }
  }, [fullscreen, mapReady]);

  useEffect(() => {
    if (clusterButtonRef.current) setClusterButtonState(clusterButtonRef.current, clustered);
  }, [clustered]);

  // ── 2. Fetch pre-built static data ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const bp = typeof window !== "undefined" ? ((window as any).CANOPY_BASE_PATH || "") : "";
    Promise.all([
      fetch(`${bp}/api/navplace.json`).then((r) => r.json()),
      fetch(`${bp}/api/search-records.json`).then((r) => r.json()),
      fetch(`${bp}/api/search-index.json`).then((r) => r.json()),
    ])
      .then(
        ([navData, records, indexData]: [
          { manifests: NavManifest[] },
          SearchRecord[],
          SearchIndexEntry[]
        ]) => {
          if (cancelled) return;

          const hrefToMeta = new Map<string, string[]>();
          records.forEach((rec) => {
            const entry = indexData.find((e) => e.id === rec.id);
            if (entry) hrefToMeta.set(rec.href, entry.metadata);
          });

          const enriched: EnrichedMarker[] = [];
          navData.manifests.forEach((manifest) => {
            const meta = hrefToMeta.get(manifest.href);
            // Undated buildings keep dateBuilt = null and are shown at every slider position
            const dateBuilt = parseYear(meta?.[0]);
            const razedRaw = meta?.[1];
            const standing = !razedRaw || razedRaw.toLowerCase() === "present";
            const dateRazed = standing ? CURRENT_YEAR : (parseYear(razedRaw) ?? CURRENT_YEAR);

            manifest.features.forEach((feature, i) => {
              enriched.push({
                id: feature.id || `${manifest.slug}-${i}`,
                lat: feature.lat,
                lng: feature.lng,
                title: manifest.title,
                href: manifest.href,
                thumbnail: manifest.thumbnail,
                thumbnailWidth: manifest.thumbnailWidth,
                thumbnailHeight: manifest.thumbnailHeight,
                dateBuilt,
                dateRazed,
                standing,
              });
            });
          });

          setMarkers(enriched);
          setLoading(false);
        }
      )
      .catch((err: Error) => {
        if (!cancelled) {
          setFetchError(err.message ?? "Unknown error");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  // ── 3. Compute year range ──────────────────────────────────────────────
  const { minYear, maxYear } = useMemo(() => {
    if (!markers.length) return { minYear: 1870, maxYear: 2000 };
    let min = Infinity, max = -Infinity;
    markers.forEach(({ dateBuilt, dateRazed }) => {
      if (dateBuilt !== null) {
        if (dateBuilt < min) min = dateBuilt;
        if (dateBuilt > max) max = dateBuilt;
      }
      if (dateRazed !== null && dateRazed > max) max = dateRazed;
    });
    return {
      minYear: isFinite(min) ? min : 1870,
      maxYear: isFinite(max) ? max : 2000,
    };
  }, [markers]);

  // ── 4. Init slider: from the URL hash if given, else the full span ────
  useEffect(() => {
    if (!markers.length) return;
    const h = initialHashRef.current ?? {};
    const clamp = (y: number) => Math.min(maxYear, Math.max(minYear, y));
    const hasYears = h.start !== undefined && h.end !== undefined && h.start <= h.end;
    if (startYear === null) setStartYear(hasYears ? clamp(h.start) : minYear);
    if (endYear === null) setEndYear(hasYears ? clamp(h.end) : maxYear);
  }, [markers, minYear, maxYear, startYear, endYear]);

  // ── 4b. Keep the URL hash in step with the view ───────────────────────
  // replaceState, so moving the map doesn't fill the back button's history
  function writeHash(): void {
    const map = mapInstanceRef.current;
    if (!map || typeof window === "undefined") return;
    const parts: string[] = [];
    const { start, end } = yearRangeRef.current;
    if (start !== null && end !== null && (start !== minYearRef.current || end !== maxYearRef.current)) {
      parts.push(`years=${start}-${end}`);
    }
    const c = map.getCenter();
    const z = Math.round(map.getZoom() * 100) / 100;
    parts.push(`map=${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
    const on = [...georefByKeyRef.current].filter(([, l]) => map.hasLayer(l)).map(([k]) => k);
    if (on.length) parts.push(`overlays=${on.join(",")}`);
    if (baseIndexRef.current > 0) parts.push(`base=${baseIndexRef.current}`);
    if (opacityRef.current !== 100) parts.push(`opacity=${opacityRef.current}`);
    const hash = `#${parts.join("&")}`;
    if (hash !== window.location.hash) {
      history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
  }

  function scheduleHashWrite(): void {
    if (hashTimerRef.current !== null) window.clearTimeout(hashTimerRef.current);
    hashTimerRef.current = window.setTimeout(() => {
      hashTimerRef.current = null;
      writeHash();
    }, 250);
  }
  const scheduleHashWriteRef = useRef(scheduleHashWrite);
  scheduleHashWriteRef.current = scheduleHashWrite;
  const writeHashRef = useRef(writeHash);
  writeHashRef.current = writeHash;

  const minYearRef = useRef(minYear);
  const maxYearRef = useRef(maxYear);
  minYearRef.current = minYear;
  maxYearRef.current = maxYear;

  useEffect(() => {
    if (startYear !== null && endYear !== null) scheduleHashWriteRef.current();
  }, [startYear, endYear, overlayOpacity]);

  // ── 5. Filter markers ─────────────────────────────────────────────────
  const filteredMarkers = useMemo(() => {
    if (!markers.length || startYear === null || endYear === null) return markers;
    return markers.filter(({ dateBuilt, dateRazed }) => {
      if (dateBuilt === null) return true;
      if (dateBuilt > endYear) return false;
      if (dateRazed < startYear) return false;
      return true;
    });
  }, [markers, startYear, endYear]);

  // ── 6. Initialise Leaflet map ─────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      scrollWheelZoom: true,
      zoomControl: true,
      // The Allmaps plugin can't animate zooms of more than one level
      zoomAnimationThreshold: 1,
    });

    // Tile layers
    const layers = tileLayers ?? [];
    const baseMapLayers: Record<string, L.TileLayer> = {};
    const hash = initialHashRef.current ?? {};
    const startBase =
      hash.base !== undefined && Number.isInteger(hash.base) && hash.base >= 0 && hash.base < layers.length
        ? hash.base
        : 0;
    baseIndexRef.current = startBase;
    if (layers.length > 0) {
      layers.forEach((tl, i) => {
        const layer = L.tileLayer(tl.url, {
          attribution: tl.attribution,
          maxZoom: tl.maxZoom ?? 19,
        });
        baseMapLayers[tl.name] = layer;
        if (i === startBase) layer.addTo(map);
      });
    }
    map.on("baselayerchange", (e: any) => {
      baseIndexRef.current = Math.max(0, layers.findIndex((tl) => tl.name === e.name));
      scheduleHashWriteRef.current();
    });

    // Georeferenced overlays sit above every base layer (tilePane, z 200) but
    // below vector overlays (400) and markers / clusters (600). Each gets its
    // own pane so later entries draw on top of earlier ones.
    const georefLayers: Record<string, L.Layer> = {};
    (georefAnnotations ?? []).forEach((ga, i) => {
      const paneName = `georef-${i}`;
      const pane = map.createPane(paneName);
      pane.style.zIndex = String(250 + i);
      pane.style.pointerEvents = "none";
      georefLayers[ga.name] = new GeorefToggleLayer(ga.url, paneName);
    });
    georefByKeyRef.current = new Map(
      (georefAnnotations ?? []).map((ga) => [annotationKey(ga.url), georefLayers[ga.name]])
    );
    const georefList = Object.values(georefLayers);
    georefPanesRef.current = (georefAnnotations ?? []).map((_, i) => `georef-${i}`);
    if (georefList.length > 0) {
      // Show the opacity slider only while some historic imagery is on
      map.on("layeradd layerremove", () =>
        setOverlayVisible(georefList.some((l) => map.hasLayer(l)))
      );
    }

    if (layers.length > 1 || georefList.length > 0) {
      L.control.layers(baseMapLayers, georefLayers).addTo(map);
    }

    // Full screen toggle, under the zoom buttons
    const FullscreenControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", bar) as HTMLAnchorElement;
        btn.href = "#";
        btn.setAttribute("role", "button");
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.color = "#333";
        btn.innerHTML = EXPAND_ICON;
        btn.title = "View full screen";
        btn.setAttribute("aria-label", "View full screen");
        btn.setAttribute("aria-pressed", "false");
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          toggleFullscreenRef.current();
        });
        fullscreenButtonRef.current = btn;
        return bar;
      },
    });
    new FullscreenControl().addTo(map);

    // Group / ungroup toggle. Ungrouped markers stay separate at every zoom.
    if (cluster) {
      const ClusterControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          const btn = L.DomUtil.create("a", "", bar) as HTMLAnchorElement;
          btn.href = "#";
          btn.setAttribute("role", "button");
          btn.style.display = "flex";
          btn.style.alignItems = "center";
          btn.style.justifyContent = "center";
          btn.style.color = "#500000";
          setClusterButtonState(btn, true);
          L.DomEvent.disableClickPropagation(bar);
          L.DomEvent.on(btn, "click", (e) => {
            L.DomEvent.preventDefault(e);
            setClustered((c) => !c);
          });
          clusterButtonRef.current = btn;
          return bar;
        },
      });
      new ClusterControl().addTo(map);
    }

    // Show / hide every georeferenced overlay at once
    if (georefList.length > 0) {
      const anyVisible = () => georefList.some((l) => map.hasLayer(l));
      const OverlayControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          const btn = L.DomUtil.create("a", "", bar) as HTMLAnchorElement;
          btn.href = "#";
          btn.setAttribute("role", "button");
          btn.style.display = "flex";
          btn.style.alignItems = "center";
          btn.style.justifyContent = "center";
          btn.innerHTML = OVERLAY_ICON;
          setOverlayButtonState(btn, false);
          L.DomEvent.disableClickPropagation(bar);
          L.DomEvent.on(btn, "click", (e) => {
            L.DomEvent.preventDefault(e);
            const show = !anyVisible();
            georefList.forEach((l) => (show ? map.addLayer(l) : map.removeLayer(l)));
          });
          // Keep the button in sync with the layer switcher checkboxes
          map.on("layeradd layerremove", () => setOverlayButtonState(btn, anyVisible()));
          return bar;
        },
      });
      new OverlayControl().addTo(map);
    }

    // Copy a link to this view (the URL hash already holds it)
    const ShareControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", bar) as HTMLAnchorElement;
        btn.href = "#";
        btn.setAttribute("role", "button");
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.color = "#500000";
        const setState = (copied: boolean) => {
          const label = copied ? "Link copied" : "Copy link to this view";
          btn.innerHTML = copied ? CHECK_ICON : LINK_ICON;
          btn.title = label;
          btn.setAttribute("aria-label", label);
        };
        setState(false);
        let resetTimer: number | undefined;
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          // Flush any pending update so the copied link matches the screen
          if (hashTimerRef.current !== null) {
            window.clearTimeout(hashTimerRef.current);
            hashTimerRef.current = null;
          }
          writeHashRef.current();
          const url = window.location.href;
          const done = () => {
            setState(true);
            window.clearTimeout(resetTimer);
            resetTimer = window.setTimeout(() => setState(false), 2000);
          };
          // Clipboard blocked (e.g. insecure page): show the link to copy by hand.
          // Some embedded browsers have no prompt(), so don't let that throw.
          const fallback = () => {
            try {
              window.prompt("Copy this link:", url);
            } catch {
              /* the address bar already shows the link */
            }
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url).then(done, fallback);
          } else {
            fallback();
          }
          trackMapEvent("share-link-copy", { url }, { share_url: truncate(url) });
        });
        return bar;
      },
    });
    new ShareControl().addTo(map);

    // Starting view: the URL hash's, else the `center`/`zoom` props, else a
    // placeholder while data loads, replaced by fitting the markers
    if (hash.zoom !== undefined && hash.lat !== undefined && hash.lng !== undefined) {
      map.setView([hash.lat, hash.lng], hash.zoom);
      initialBoundsSetRef.current = true;
    } else if (center && zoom !== undefined) {
      map.setView(center, zoom);
      initialBoundsSetRef.current = true;
    } else {
      map.setView([30.618, -96.336], 15);
    }

    // Overlays named in the hash
    (hash.overlays ?? []).forEach((key) => {
      const layer = georefByKeyRef.current.get(key);
      if (layer) map.addLayer(layer);
    });

    // Links on the page that change only the hash (e.g. "Campus in 1933")
    // reload nothing, so apply them here. Our own replaceState writes don't
    // fire hashchange.
    const baseList = layers.map((tl) => baseMapLayers[tl.name]);
    const onHashChange = () => {
      const h = readHash();
      if (h.zoom !== undefined && h.lat !== undefined && h.lng !== undefined) {
        map.setView([h.lat, h.lng], h.zoom);
      }
      const nextBase =
        h.base !== undefined && Number.isInteger(h.base) && h.base >= 0 && h.base < baseList.length ? h.base : 0;
      if (baseList.length && nextBase !== baseIndexRef.current) {
        map.removeLayer(baseList[baseIndexRef.current]);
        map.addLayer(baseList[nextBase]);
        baseIndexRef.current = nextBase;
      }
      const want = new Set(h.overlays ?? []);
      georefByKeyRef.current.forEach((layer, key) => {
        if (want.has(key) && !map.hasLayer(layer)) map.addLayer(layer);
        else if (!want.has(key) && map.hasLayer(layer)) map.removeLayer(layer);
      });
      setOverlayOpacity(h.opacity ?? 100);
      const lo = minYearRef.current, hi = maxYearRef.current;
      const clamp = (y: number) => Math.min(hi, Math.max(lo, y));
      const hasYears = h.start !== undefined && h.end !== undefined && h.start <= h.end;
      setStartYear(hasYears ? clamp(h.start) : lo);
      setEndYear(hasYears ? clamp(h.end) : hi);
      // Bring the map and its slider bar into view together
      rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    window.addEventListener("hashchange", onHashChange);

    map.on("moveend overlayadd overlayremove layeradd layerremove", (e: any) => {
      // Marker layers come and go with the slider; only overlays matter here
      if ((e.type === "layeradd" || e.type === "layerremove") && !georefList.includes(e.layer)) return;
      scheduleHashWriteRef.current();
    });

    mapInstanceRef.current = map;

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      map.remove();
      mapInstanceRef.current = null;
      fullscreenButtonRef.current = null;
      clusterButtonRef.current = null;
      clusterGroupRef.current = null;
      initialBoundsSetRef.current = false;
    };
  }, [mapReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 6b. Historic imagery opacity ──────────────────────────────────────
  // Set on each overlay's pane, so it also applies to overlays not yet loaded
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    georefPanesRef.current.forEach((name) => {
      const pane = map.getPane(name);
      if (pane) pane.style.opacity = String(overlayOpacity / 100);
    });
  }, [overlayOpacity, mapReady]);

  // ── 7. Sync markers to map ────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (clusterGroupRef.current) {
      map.removeLayer(clusterGroupRef.current);
    }

    const useCluster =
      cluster && clustered && typeof (L as any).markerClusterGroup === "function";

    const group: any = useCluster
      ? (L as any).markerClusterGroup({
          maxClusterRadius,
          disableClusteringAtZoom,
          iconCreateFunction: (c: any) => {
            const n = c.getChildCount();
            // All styling inline so the number is guaranteed centered
            return L.divIcon({
              className: "",
              html: `<div style="
                width:40px;height:40px;
                background:#500000;
                border-radius:50%;
                display:flex;align-items:center;justify-content:center;
                color:#fff;font-weight:700;font-size:13px;line-height:1;
                box-shadow:0 2px 8px rgba(0,0,0,.45);
                border:2px solid rgba(255,255,255,.35);
              ">${n}<span style="${SR_ONLY_INLINE}"> buildings, zoom in to see them</span></div>`,
              iconSize: L.point(40, 40),
              iconAnchor: [20, 20],
            });
          },
        })
      : L.layerGroup();

    const bp = typeof window !== "undefined" ? ((window as any).CANOPY_BASE_PATH || "") : "";
    markerByIdRef.current = new Map();
    filteredMarkers.forEach((m) => {
      const title = escapeHtml(m.title);
      const thumb = escapeHtml(m.thumbnail);
      // Leaflet makes the marker a focusable role="button" <div>; the
      // thumbnail's alt text is its accessible name (Leaflet's own `alt`
      // option only applies to image icons, not divIcons)
      const icon = L.divIcon({
        className: "",
        html: `<img src="${thumb}" style="
          width:32px;height:32px;
          border-radius:50%;
          object-fit:cover;
          border:2px solid #500000;
          box-shadow:0 1px 5px rgba(0,0,0,.45);
          display:block;
        " alt="${title}, ${escapeHtml(yearsLabel(m))}" />`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -20],
      });

      const popupContent = `
        <div style="width:200px">
          <a href="${escapeHtml(bp + m.href)}" style="text-decoration:none;color:inherit">
            <img src="${thumb}"
                 style="width:100%;height:130px;object-fit:cover;display:block"
                 alt="${title}" />
            <p style="margin:6px 4px 4px;font-size:0.85rem;font-weight:600;line-height:1.3">
              ${title}
            </p>
            <p style="margin:0 4px 6px;font-size:0.75rem;color:#666">
              ${yearsLabel(m)}
            </p>
          </a>
        </div>`;

      // `title` gives the hover tooltip
      const marker = L.marker([m.lat, m.lng], { icon, title: m.title }).bindPopup(popupContent);
      marker.building = m;
      markerByIdRef.current.set(m.id, marker);
      marker.on("click", () => {
        const { start, end } = yearRangeRef.current;
        trackMapEvent(
          "marker-click",
          { marker: markerSummary(m), zoom: map.getZoom(), startYear: start, endYear: end },
          {
            building_id: truncate(m.id),
            building_title: truncate(m.title),
            building_href: truncate(m.href),
            map_zoom: map.getZoom(),
            start_year: start ?? "",
            end_year: end ?? "",
          }
        );
      });
      marker.addTo(group);
    });

    if (useCluster) {
      group.on("clusterclick", (e: any) => {
        const c = e.layer;
        const buildings: EnrichedMarker[] = c
          .getAllChildMarkers()
          .map((mk: any) => mk.building)
          .filter(Boolean);
        const center = c.getLatLng();
        const bounds = c.getBounds();
        const { start, end } = yearRangeRef.current;
        trackMapEvent(
          "cluster-click",
          {
            count: c.getChildCount(),
            markers: buildings.map(markerSummary),
            center: { lat: center.lat, lng: center.lng },
            bounds: bounds.toBBoxString(),
            zoom: map.getZoom(),
            startYear: start,
            endYear: end,
          },
          {
            cluster_size: c.getChildCount(),
            cluster_titles: truncate(buildings.map((b) => b.title).join("; ")),
            cluster_lat: Number(center.lat.toFixed(5)),
            cluster_lng: Number(center.lng.toFixed(5)),
            map_zoom: map.getZoom(),
            start_year: start ?? "",
            end_year: end ?? "",
          }
        );
      });
    }

    group.addTo(map);
    clusterGroupRef.current = group;

    // Fit bounds only on first data load, not on every slider change
    if (filteredMarkers.length > 0 && !initialBoundsSetRef.current) {
      const bounds = L.latLngBounds(
        filteredMarkers.map((m) => [m.lat, m.lng] as [number, number])
      );
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
        initialBoundsSetRef.current = true;
      }
    }

    // A building picked from outside the date range: fly once it's on the map
    const pending = pendingFlyRef.current;
    if (pending && markerByIdRef.current.has(pending)) {
      pendingFlyRef.current = null;
      flyToBuilding(pending);
    }
  }, [filteredMarkers, mapReady, cluster, clustered, maxClusterRadius, disableClusteringAtZoom]);

  // ── 8. Building finder ────────────────────────────────────────────────

  /** Zoom to a building's marker (out of its cluster) and open its popup. */
  function flyToBuilding(id: string): void {
    const map = mapInstanceRef.current;
    const marker = markerByIdRef.current.get(id);
    if (!map || !marker) return;
    mapContainerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const group = clusterGroupRef.current;
    if (group && typeof group.zoomToShowLayer === "function") {
      group.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      // setView, not flyTo: the Allmaps layer can't animate multi-level zooms
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 18));
      marker.openPopup();
    }
  }

  function selectBuilding(m: EnrichedMarker, inRange: boolean): void {
    trackMapEvent(
      "building-search-select",
      { marker: markerSummary(m), query, inRange },
      {
        building_id: truncate(m.id),
        building_title: truncate(m.title),
        search_query: truncate(query),
        in_range: inRange,
      }
    );
    if (inRange) {
      flyToBuilding(m.id);
      return;
    }
    // Widen the date range just enough to include it; the marker sync effect
    // then flies to it
    // (a building shows when dateBuilt <= endYear and dateRazed >= startYear;
    // undated ones are always shown, so never land here)
    pendingFlyRef.current = m.id;
    if (m.dateBuilt !== null) setEndYear((e) => Math.max(e ?? m.dateBuilt, m.dateBuilt));
    if (m.dateRazed !== null) setStartYear((s) => Math.min(s ?? m.dateRazed, m.dateRazed));
  }

  const q = query.trim().toLowerCase();
  const byTitle = (a: EnrichedMarker, b: EnrichedMarker) => a.title.localeCompare(b.title);
  const visibleMatches = useMemo(
    () => filteredMarkers.filter((m) => !q || m.title.toLowerCase().includes(q)).sort(byTitle),
    [filteredMarkers, q]
  );
  const hiddenMatches = useMemo(() => {
    if (!q) return [];
    const shown = new Set(filteredMarkers.map((m) => m.id));
    return markers
      .filter((m) => !shown.has(m.id) && m.title.toLowerCase().includes(q))
      .sort(byTitle);
  }, [markers, filteredMarkers, q]);
  const showList = listOpen || q.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────

  const sy = startYear ?? minYear;
  const ey = endYear ?? maxYear;
  const count = filteredMarkers.length;
  const total = markers.length;

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        flexDirection: "column",
        ...(fullscreen ? { height: "100dvh", background: "#fff" } : {}),
        ...(pseudoFullscreen ? { position: "fixed", inset: 0, zIndex: 10000 } : {}),
      }}
    >
      {/* Map container — always in DOM so the ref is available on first mount */}
      <div style={{ position: "relative", ...(fullscreen ? { flex: 1, minHeight: 0 } : {}) }}>
        {/* `position` must stay set: Leaflet relies on the container's
            inline position: relative, and dropping it lets the map panes
            escape the container's clipping. */}
        <div
          ref={mapContainerRef}
          style={{ position: "relative", height: fullscreen ? "100%" : height }}
        />

        {(loading || !mapReady) && !fetchError && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.85)",
              zIndex: 1000,
              fontFamily: "var(--open-sans)",
              color: "var(--gray-600)",
            }}
          >
            Loading map…
          </div>
        )}

        {fetchError && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.9)",
              zIndex: 1001,
              fontFamily: "var(--open-sans)",
              color: "red",
              padding: "1rem",
            }}
          >
            Error loading map data: {fetchError}
          </div>
        )}
      </div>

      {/* ── Slider bar ─────────────────────────────────────────────────── */}
      <div
        style={{
          background: "#e9e4dc",
          padding: "0.6rem 1rem 0.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.3rem",
        }}
      >
        {/* Top row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "var(--open-sans)",
            fontSize: "0.8rem",
            color: "#333",
          }}
        >
          <span>Drag the handles to choose years</span>
          <span>{count} of {total} items</span>
        </div>

        {/* Dual-handle range slider */}
        <div className="cdrs" style={{ position: "relative", height: "20px" }}>
          {/* Base track */}
          <div style={{
            position: "absolute", top: "50%", transform: "translateY(-50%)",
            left: 0, right: 0, height: 4,
            background: "#bbb", borderRadius: 2, pointerEvents: "none",
          }} />
          {/* Colored fill between the two handles */}
          {maxYear > minYear && (
            <div style={{
              position: "absolute", top: "50%", transform: "translateY(-50%)",
              left: `${((sy - minYear) / (maxYear - minYear)) * 100}%`,
              right: `${((maxYear - ey) / (maxYear - minYear)) * 100}%`,
              height: 4, background: "#500000", borderRadius: 2,
              pointerEvents: "none",
            }} />
          )}
          <input
            type="range"
            min={minYear}
            max={maxYear}
            value={sy}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setStartYear(Math.min(v, ey));
            }}
            style={{ zIndex: sy >= ey ? 2 : 1 }}
            aria-label="Start year"
            aria-valuetext={String(sy)}
          />
          <input
            type="range"
            min={minYear}
            max={maxYear}
            value={ey}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setEndYear(Math.max(v, sy));
            }}
            style={{ zIndex: sy < ey ? 2 : 1 }}
            aria-label="End year"
            aria-valuetext={`${ey}, ${count} of ${total} buildings shown`}
          />
        </div>

        {/* Bottom row: start · span · end */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "var(--open-sans)",
            fontSize: "0.75rem",
            color: "#555",
            paddingTop: "2px",
          }}
        >
          <span style={{ fontWeight: 600, color: "#000", fontSize: "0.85rem" }}>{sy}</span>
          <span>{ey === sy ? `Standing in ${sy}` : `${ey - sy} year span`}</span>
          <span style={{ fontWeight: 600, color: "#000", fontSize: "0.85rem" }}>{ey}</span>
        </div>

        {/* Historic imagery opacity, shown while any overlay is on */}
        {overlayVisible && (
          <div
            className="georef-opacity"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.4rem 0.6rem",
              fontFamily: "var(--open-sans)",
              fontSize: "0.8rem",
              color: "#500000",
              background: "#fff",
              border: "1px solid #d6cfc4",
              borderLeft: "4px solid #500000",
              borderRadius: 4,
              padding: "0.4rem 0.75rem",
              marginTop: "0.35rem",
            }}
          >
            <span
              style={{ display: "flex", flexShrink: 0 }}
              dangerouslySetInnerHTML={{ __html: OVERLAY_ICON }}
            />
            <label htmlFor="georef-opacity" style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
              Historic imagery opacity
            </label>
            <input
              id="georef-opacity"
              type="range"
              min={0}
              max={100}
              step={5}
              value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
              aria-valuetext={`${overlayOpacity}%`}
              // Wraps onto its own line when the row is too narrow (phones)
              style={{ flex: "1 1 180px", minWidth: 0 }}
            />
            <span style={{ fontWeight: 700, minWidth: "4ch", textAlign: "right" }}>
              {overlayOpacity}%
            </span>
          </div>
        )}

        {/* Building finder: search box plus a collapsible list of buildings */}
        <div
          className="building-finder"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.35rem",
            marginTop: "0.35rem",
            fontFamily: "var(--open-sans)",
            fontSize: "0.8rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="building-search" className="sr-only" style={SR_ONLY}>
              Find a building
            </label>
            <input
              id="building-search"
              type="search"
              placeholder="Find a building…"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (visibleMatches[0]) selectBuilding(visibleMatches[0], true);
                  else if (hiddenMatches[0]) selectBuilding(hiddenMatches[0], false);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              aria-controls="building-list"
              style={{
                flex: "1 1 180px",
                minWidth: 0,
                padding: "0.4rem 0.6rem",
                border: "1px solid #bbb",
                borderRadius: 4,
                font: "inherit",
                fontSize: "0.85rem",
                background: "#fff",
                color: "#000",
              }}
            />
            <button
              type="button"
              onClick={() => setListOpen((o) => !o)}
              aria-expanded={showList}
              aria-controls="building-list"
              style={{
                padding: "0.4rem 0.7rem",
                border: "1px solid #500000",
                borderRadius: 4,
                background: showList ? "#500000" : "#fff",
                color: showList ? "#fff" : "#500000",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {showList ? "Hide list" : `List buildings (${count})`}
            </button>
          </div>

          {showList && (
            <div
              id="building-list"
              style={{
                maxHeight: 240,
                overflowY: "auto",
                background: "#fff",
                border: "1px solid #d6cfc4",
                borderRadius: 4,
              }}
            >
              <div aria-live="polite" style={{ padding: "0.35rem 0.6rem", color: "#555" }}>
                {q
                  ? `${visibleMatches.length} on the map match “${query.trim()}”`
                  : `${count} buildings standing between ${sy} and ${ey}`}
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {visibleMatches.map((m) => (
                  <li key={m.id}>
                    <button type="button" className="bf-item" onClick={() => selectBuilding(m, true)}>
                      <span>{m.title}</span>
                      <span className="bf-years">{yearsLabel(m)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {hiddenMatches.length > 0 && (
                <>
                  <div style={{ padding: "0.35rem 0.6rem", color: "#555", borderTop: "1px solid #e9e4dc" }}>
                    Outside {sy}–{ey} (selecting one widens the date range)
                  </div>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {hiddenMatches.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="bf-item bf-hidden"
                          onClick={() => selectBuilding(m, false)}
                        >
                          <span>{m.title}</span>
                          <span className="bf-years">{yearsLabel(m)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {q && visibleMatches.length === 0 && hiddenMatches.length === 0 && (
                <div style={{ padding: "0.35rem 0.6rem 0.6rem", color: "#555" }}>
                  No buildings match.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Visually hidden but read by screen readers
const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};