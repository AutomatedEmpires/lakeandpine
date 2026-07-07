"use client";

import { useEffect, useRef } from "react";

import { AreaMapSvg } from "./AreaMapSvg";

type AreaPin = { city: string; lat: number | null; lng: number | null };

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Mapbox is the cross-app maps standard. Without a token we render the branded
// SVG map (design-faithful fallback), so this component is always safe to use.
export function AreaMap({ areas, highlight }: { areas: AreaPin[]; highlight?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current) return;
    let cancelled = false;
    let map: { remove: () => void } | null = null;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      await import("mapbox-gl/dist/mapbox-gl.css");
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = MAPBOX_TOKEN;
      const instance = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/outdoors-v12",
        center: [-116.9, 47.68],
        zoom: 9,
        attributionControl: false,
      });
      map = instance;
      for (const area of areas) {
        if (area.lat == null || area.lng == null) continue;
        const el = document.createElement("div");
        el.className = "pin";
        el.style.position = "relative";
        el.style.transform = "none";
        el.textContent = area.city;
        if (highlight && area.city === highlight) {
          el.style.borderColor = "rgba(0,185,152,.6)";
        }
        new mapboxgl.Marker({ element: el }).setLngLat([area.lng, area.lat]).addTo(instance);
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [areas, highlight]);

  if (!MAPBOX_TOKEN) {
    return <AreaMapSvg highlight={highlight} />;
  }
  return <div ref={containerRef} className="map card" />;
}
