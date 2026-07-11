// The prototype's stylized Inland Northwest map. Used as the branded fallback
// whenever NEXT_PUBLIC_MAPBOX_TOKEN is absent (Mapbox is the cross-app standard).
const PINS = [
  { className: "p-rath", label: "Rathdrum" },
  { className: "p-hayden", label: "Hayden" },
  { className: "p-cda", label: "Coeur d'Alene" },
  { className: "p-post", label: "Post Falls" },
  { className: "p-spokane", label: "Spokane" },
  { className: "p-valley", label: "Spokane Valley" },
  { className: "p-liberty", label: "Liberty Lake" },
];

export function AreaMapSvg({ highlight }: { highlight?: string }) {
  return (
    <div className="map card">
      <svg viewBox="0 0 700 560" preserveAspectRatio="none" aria-hidden>
        <path
          d="M0 150 C130 80 210 210 350 150 C490 90 560 190 700 110"
          fill="none"
          stroke="rgba(71,216,231,.46)"
          strokeWidth="22"
        />
        <path
          d="M55 465 C165 350 250 430 360 310 C485 175 610 265 700 190"
          fill="none"
          stroke="rgba(71,216,231,.32)"
          strokeWidth="14"
        />
        <path
          d="M100 0 L215 560 M350 0 L305 560 M520 0 L610 560"
          stroke="rgba(5,95,79,.18)"
          strokeWidth="2"
        />
      </svg>
      {PINS.map((pin) => (
        <span
          key={pin.className}
          className={`pin ${pin.className}`}
          style={
            highlight && pin.label.toLowerCase().startsWith(highlight.toLowerCase().slice(0, 5))
              ? { borderColor: "rgba(0,185,152,.6)", fontWeight: 950 }
              : undefined
          }
        >
          {pin.label}
        </span>
      ))}
    </div>
  );
}
