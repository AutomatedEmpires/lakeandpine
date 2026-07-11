import Link from "next/link";

import { BrandMark } from "./BrandMark";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div>
          <BrandMark />
          <p>
            Premium home cleaning across Coeur d&rsquo;Alene, Spokane, Post Falls, Hayden,
            Liberty Lake, Spokane Valley, and Rathdrum.
          </p>
        </div>
        <div>
          <h4>Services</h4>
          <Link href="/services">Essential Reset</Link>
          <Link href="/services">Deep Clean</Link>
          <Link href="/services">Move In / Out</Link>
          <Link href="/services">Turnover</Link>
        </div>
        <div>
          <h4>Book</h4>
          <Link href="/pricing">Pricing</Link>
          <Link href="/book">Schedule</Link>
          <Link href="/dashboard">Dashboard</Link>
        </div>
        <div>
          <h4>Areas</h4>
          <Link href="/areas/coeur-dalene">CDA</Link>
          <Link href="/areas/spokane">Spokane</Link>
          <Link href="/areas/post-falls">Post Falls</Link>
          <Link href="/areas/liberty-lake">Liberty Lake</Link>
        </div>
        <div>
          <h4>Trust</h4>
          <p>Licensed</p>
          <p>Bonded</p>
          <p>Insured</p>
          <p>Background checked</p>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Lake &amp; Pine Cleaning Co.</span>
        <span>Licensed · Bonded · Insured · Inland Northwest</span>
      </div>
    </footer>
  );
}
