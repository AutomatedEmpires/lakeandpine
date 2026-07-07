import Link from "next/link";

export function BrandMark() {
  return (
    <Link className="brand" href="/">
      <span className="mark" aria-hidden>
        <svg viewBox="0 0 64 64" fill="none">
          <path d="M32 5l14 20h-8l11 17H15l11-17h-8L32 5z" fill="currentColor" />
          <path
            d="M16 52c8-5 16 5 25 0 3-2 6-3 9-2"
            stroke="rgba(255,255,255,.9)"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span>
        Lake &amp; Pine<small>Cleaning Co.</small>
      </span>
    </Link>
  );
}
