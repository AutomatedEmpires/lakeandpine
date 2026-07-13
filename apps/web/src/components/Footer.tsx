import Link from "next/link";

import { BrandMark } from "./BrandMark";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div>
          <BrandMark />
          <p>
            Calm, practical service planning for homes that deserve a thoughtful handoff.
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
          <h4>Plan</h4>
          <Link href="/pricing">Pricing</Link>
          <Link href="/book">Build a request</Link>
          <Link href="/dashboard">Dashboard</Link>
        </div>
        <div>
          <h4>Workflow</h4>
          <p>Request</p>
          <p>Plan review</p>
          <p>Confirmation</p>
          <p>Service status</p>
        </div>
        <div>
          <h4>Phase 1</h4>
          <p>No online payment</p>
          <p>No live slot promises</p>
          <p>Human scope review</p>
          <p>Private operator notes</p>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Lake &amp; Pine Cleaning Co.</span>
        <span>Request · plan · confirm · follow up</span>
      </div>
    </footer>
  );
}
