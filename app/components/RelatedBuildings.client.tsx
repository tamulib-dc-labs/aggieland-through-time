import React, { useEffect, useState } from "react";

/**
 * "Nearby" and "From the same era" lists for a building page, built in the
 * browser from the site's static map data (the same files the campus map
 * reads), so every building can be compared with every other.
 */

type NavManifest = {
  id: string;
  slug: string;
  href: string;
  title: string;
  thumbnail: string;
  features: { lat: number; lng: number }[];
};
type SearchRecord = { id: string; href: string };
type SearchIndexEntry = { id: string; metadata: string[] };

type Building = {
  id: string;
  href: string;
  title: string;
  thumbnail: string;
  lat: number;
  lng: number;
  built: number | null;
  razed: number | null; // null = still standing
};

const CURRENT_YEAR = new Date().getFullYear();
const PER_LIST = 4;

function parseYear(val: string | undefined): number | null {
  const m = String(val ?? "").match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

function yearsLabel(b: Building): string {
  if (b.built === null) return "Date unknown";
  return `${b.built} – ${b.razed ?? "Present"}`;
}

/** Metres between two points (haversine). */
function distance(a: Building, b: Building): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceLabel(m: number): string {
  // US audience: feet up close, miles further out
  const feet = m * 3.28084;
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft away`;
  return `${(m / 1609.34).toFixed(1)} mi away`;
}

async function loadBuildings(base: string): Promise<Building[]> {
  const [nav, records, index]: [{ manifests: NavManifest[] }, SearchRecord[], SearchIndexEntry[]] =
    await Promise.all(
      ["navplace", "search-records", "search-index"].map((n) =>
        fetch(`${base}/api/${n}.json`).then((r) => {
          if (!r.ok) throw new Error(`${n}.json: ${r.status}`);
          return r.json();
        })
      ) as any
    );
  const metaById = new Map(index.map((e) => [e.id, e.metadata]));
  const metaByHref = new Map(records.map((r) => [r.href, metaById.get(r.id)]));
  const out: Building[] = [];
  for (const m of nav.manifests) {
    const f = m.features?.[0];
    if (!f) continue;
    const meta = metaByHref.get(m.href);
    const razedRaw = meta?.[1];
    const standing = !razedRaw || razedRaw.toLowerCase() === "present";
    out.push({
      id: m.id,
      href: m.href,
      title: m.title,
      thumbnail: m.thumbnail,
      lat: f.lat,
      lng: f.lng,
      built: parseYear(meta?.[0]),
      razed: standing ? null : parseYear(razedRaw),
    });
  }
  return out;
}

function Card({ b, note, base }: { b: Building; note: string; base: string }) {
  return (
    <li>
      <a className="related-buildings__card" href={`${base}${b.href}`}>
        {b.thumbnail ? <img src={b.thumbnail} alt="" loading="lazy" /> : <span className="related-buildings__noimg" />}
        <span className="related-buildings__title">{b.title}</span>
        <span className="related-buildings__meta">
          {yearsLabel(b)} · {note}
        </span>
      </a>
    </li>
  );
}

export default function RelatedBuildings({ manifestId }: { manifestId?: string }) {
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [error, setError] = useState(false);
  const base = typeof window !== "undefined" ? (window as any).CANOPY_BASE_PATH || "" : "";

  useEffect(() => {
    let cancelled = false;
    loadBuildings(base)
      .then((b) => !cancelled && setBuildings(b))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [base]);

  if (error || !buildings) return null;
  const self = buildings.find((b) => b.id === manifestId);
  if (!self) return null;
  const others = buildings.filter((b) => b.id !== self.id && b.href !== self.href);

  const nearby = others
    .map((b) => ({ b, d: distance(self, b) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, PER_LIST);

  // Same era: stood at the same time as this building, closest in build year
  let sameEra: { b: Building; gap: number }[] = [];
  if (self.built !== null) {
    const selfEnd = self.razed ?? CURRENT_YEAR;
    sameEra = others
      .filter((b) => b.built !== null && b.built <= selfEnd && (b.razed ?? CURRENT_YEAR) >= self.built!)
      .map((b) => ({ b, gap: b.built! - self.built! }))
      .sort((x, y) => Math.abs(x.gap) - Math.abs(y.gap) || x.b.title.localeCompare(y.b.title))
      .slice(0, PER_LIST);
  }

  // e.g. "same year", "2 years later", "1 year earlier"
  const eraNote = (gap: number) => {
    if (gap === 0) return "same year";
    const n = Math.abs(gap);
    return `${n} year${n === 1 ? "" : "s"} ${gap > 0 ? "later" : "earlier"}`;
  };

  return (
    <div className="related-buildings">
      {nearby.length > 0 && (
        <section aria-labelledby="related-nearby">
          <h2 id="related-nearby">Nearby</h2>
          <ul>
            {nearby.map(({ b, d }) => (
              <Card key={b.id} b={b} note={distanceLabel(d)} base={base} />
            ))}
          </ul>
        </section>
      )}
      {sameEra.length > 0 && (
        <section aria-labelledby="related-era">
          <h2 id="related-era">From the same era</h2>
          <ul>
            {sameEra.map(({ b, gap }) => (
              <Card key={b.id} b={b} note={eraNote(gap)} base={base} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
