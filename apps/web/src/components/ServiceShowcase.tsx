"use client";

import Link from "next/link";
import { useState } from "react";

export type ShowcaseService = {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  price_label: string;
  tags: string[];
};

export function ServiceShowcase({ services }: { services: ShowcaseService[] }) {
  const [current, setCurrent] = useState(0);
  const service = services[current];
  if (!service) return null;

  return (
    <div className="service-showcase">
      <aside className="rail card">
        {services.map((s, i) => (
          <button
            key={s.id}
            className={`rail-btn${i === current ? " active" : ""}`}
            onClick={() => setCurrent(i)}
          >
            <span className="icon">{s.icon}</span>
            <span>
              {s.title}
              <br />
              <small>{s.price_label}</small>
            </span>
          </button>
        ))}
      </aside>
      <div className="service-canvas card">
        <div
          className="service-art"
          style={{
            background: `radial-gradient(circle at ${58 + current * 5}% ${18 + current * 5}%,rgba(255,255,255,.84),transparent 9rem),linear-gradient(${135 + current * 18}deg,#fff3df,#d9fff8 ${52 + current * 5}%,#f9e0d4)`,
          }}
        />
        <div className="service-details">
          <span className="eyebrow">{service.price_label}</span>
          <h3>{service.title}</h3>
          <p className="copy">{service.blurb}</p>
          <div className="tag-row" style={{ marginTop: 12 }}>
            {service.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="hero-actions">
          <Link className="btn btn-primary" href={`/book?service=${service.id}`}>
            Book this service
          </Link>
          <Link className="btn btn-soft" href="/pricing">
            Compare pricing
          </Link>
        </div>
      </div>
    </div>
  );
}
