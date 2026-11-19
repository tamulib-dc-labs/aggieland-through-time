import React from "react";

/**
 * The top of a building page: a one-line summary of when the building stood,
 * its description as the lead paragraph, a link that opens the campus map at
 * this building in its years, and the remaining catalog fields folded into
 * "Item details".
 *
 * Rendered at build time from the work's IIIF manifest (`props.manifest`).
 */

type IntlString = Record<string, string[]> | string | undefined | null;
type MetadataEntry = { label?: IntlString; value?: IntlString };

type Manifest = {
  id?: string;
  metadata?: MetadataEntry[];
  rights?: string;
  navPlace?: { features?: Feature[] } & Partial<Feature>;
  navplace?: { features?: Feature[] } & Partial<Feature>;
};
type Feature = { type?: string; geometry?: { coordinates?: number[] } };

// Historic overlays on the campus map, keyed as in its share links (the last
// segment of each Allmaps annotation URL). Keep in step with content/map/index.mdx.
const HISTORIC_MAPS: { year: number; key: string }[] = [
  { year: 1914, key: "451d554d53d927da" },
  { year: 1933, key: "66a196ddd627845c" },
  { year: 1950, key: "cf48dfb6963c239c" },
  { year: 1969, key: "7d41ab5ca0cc3c23" },
  { year: 1980, key: "69086660d77babb8" },
  { year: 1995, key: "d403378583fb0834" },
  { year: 1996, key: "7f7b32bfbbb98950" },
];

// Shown in the fact line or the lead instead of the details list
const PROMOTED = new Set(["date built", "date razed", "description", "rights", "rights details"]);

function text(value: IntlString): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  for (const key of Object.keys(value)) {
    const arr = value[key];
    if (Array.isArray(arr) && arr.length) return arr.map(String);
  }
  return [];
}

function parseYear(val: string | undefined): number | null {
  const m = String(val ?? "").match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

function firstPoint(manifest: Manifest): { lat: number; lng: number } | null {
  const np = manifest.navPlace || manifest.navplace;
  const features: Feature[] = Array.isArray(np?.features) ? np!.features! : np?.type === "Feature" ? [np as Feature] : [];
  for (const f of features) {
    const [lng, lat] = f?.geometry?.coordinates ?? [];
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

const MapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M8 15s5-4.6 5-8.5A5 5 0 0 0 3 6.5C3 10.4 8 15 8 15Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <circle cx="8" cy="6.5" r="1.75" fill="currentColor" />
  </svg>
);

export default function BuildingFacts({ manifest }: { manifest?: Manifest }) {
  if (!manifest) return null;
  const fields = (manifest.metadata ?? []).map((m) => ({
    label: text(m.label)[0] ?? "",
    values: text(m.value),
  }));
  const field = (name: string) => fields.find((f) => f.label.toLowerCase() === name)?.values[0];

  const built = parseYear(field("date built"));
  const razedRaw = field("date razed");
  const standing = !razedRaw || razedRaw.toLowerCase() === "present";
  const razed = standing ? null : parseYear(razedRaw);
  const description = field("description");
  const rightsLabel = field("rights details");
  const rightsUrl = manifest.rights || field("rights");

  const facts: string[] = [];
  facts.push(built !== null ? `Built ${built}` : "Date built unknown");
  if (standing) facts.push("Still standing");
  else facts.push(razed !== null ? `Demolished ${razed}` : "Demolished");

  // Campus map link: this building, close up, in the years it stood, with a
  // historic map from its lifetime when there is one
  const point = firstPoint(manifest);
  let mapHref: string | null = null;
  if (point) {
    const end = razed ?? new Date().getFullYear();
    const parts: string[] = [];
    if (built !== null) parts.push(`years=${built}-${Math.max(end, built)}`);
    parts.push(`map=18/${point.lat.toFixed(5)}/${point.lng.toFixed(5)}`);
    const historic = built !== null ? HISTORIC_MAPS.find((h) => h.year >= built && h.year <= end) : undefined;
    if (historic) parts.push(`overlays=${historic.key}`);
    const base = process.env.CANOPY_BASE_PATH || "";
    mapHref = `${base}/map/#${parts.join("&")}`;
  }

  const details = fields.filter((f) => f.label && f.values.length && !PROMOTED.has(f.label.toLowerCase()));

  return (
    <div className="building-facts">
      <p className="building-facts__line">{facts.join(" · ")}</p>
      {description && <p className="building-facts__lead">{description}</p>}
      {mapHref && (
        <a className="building-facts__map" href={mapHref}>
          <MapIcon />
          <span>See it on the campus map</span>
        </a>
      )}
      {(details.length > 0 || rightsUrl || rightsLabel) && (
        <details className="building-facts__details">
          <summary>Item details</summary>
          <dl>
            {details.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.values.join("; ")}</dd>
              </div>
            ))}
            {(rightsUrl || rightsLabel) && (
              <div>
                <dt>Rights</dt>
                <dd>
                  {rightsUrl && /^https?:/i.test(rightsUrl) ? (
                    <a href={rightsUrl} target="_blank" rel="noopener noreferrer">
                      {rightsLabel || rightsUrl}
                    </a>
                  ) : (
                    rightsLabel || rightsUrl
                  )}
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}
