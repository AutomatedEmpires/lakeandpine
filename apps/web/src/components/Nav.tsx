"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { PUBLIC_ROUTE_LINKS } from "@/lib/market-content";

import { BrandMark } from "./BrandMark";

const LINKS = PUBLIC_ROUTE_LINKS;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Nav({ phone, phoneTel }: { phone?: string; phoneTel?: string }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("menu-open", menuOpen);
    return () => document.body.classList.remove("menu-open");
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    const bar = document.getElementById("scrollbar");
    if (!bar) return;
    const onScroll = () => {
      const height = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = `${height > 0 ? (window.scrollY / height) * 100 : 0}%`;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "night" ? "day" : "night";
    root.dataset.theme = next;
    try {
      localStorage.setItem("lp-theme", next);
    } catch {}
  }

  return (
    <>
      <div className="scrollbar" id="scrollbar" />
      <header className="nav">
        <div className="nav-shell">
          <BrandMark />
          <nav className="nav-links" aria-label="Primary">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                className={`nav-link${isActive(pathname, link.href) ? " active" : ""}`}
                href={link.href}
                aria-current={isActive(pathname, link.href) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="nav-actions">
            {phone && phoneTel ? (
              <a className="btn btn-soft desktop-phone" href={phoneTel}>
                ☎ {phone}
              </a>
            ) : null}
            <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle day/night theme">
              ◐
            </button>
            <Link className="btn btn-primary" href="/book">
              Request consultation
            </Link>
            <button
              className="icon-btn hamb"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={menuOpen}
            >
              ☰
            </button>
          </div>
        </div>
      </header>
      <aside
        className={`mobile-menu${menuOpen ? " open" : ""}`}
        aria-label="Mobile navigation"
        aria-hidden={!menuOpen}
        inert={!menuOpen}
      >
        {LINKS.map((link) => (
          <Link
            key={link.href}
            className={`nav-link${isActive(pathname, link.href) ? " active" : ""}`}
            href={link.href}
            onClick={() => setMenuOpen(false)}
            aria-current={isActive(pathname, link.href) ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
        {phoneTel ? (
          <a className="btn btn-primary" href={phoneTel}>
            Call or Text
          </a>
        ) : (
          <Link className="btn btn-primary" href="/book">
            Request consultation
          </Link>
        )}
      </aside>
    </>
  );
}
