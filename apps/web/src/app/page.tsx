const serviceLines = [
  "Recurring home reset",
  "Deep clean",
  "Move-in and move-out detail",
  "Vacation rental turnover",
  "Small office refresh",
];

const productSystems = [
  "Trust-first homepage and reviews",
  "Instant estimate and pricing engine",
  "Booking and scheduling",
  "Customer dashboard and billing",
  "AI concierge and support",
  "Local SEO service-area architecture",
];

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Lake and Pine production foundation</p>
          <h1>Build the real product around the recovered customer journey.</h1>
          <p className="lede">
            This branch turns the recovered Claude Desktop prototype into a production application baseline
            without altering the historical artifact itself.
          </p>
          <div className="actions">
            <a className="primary" href="#systems">
              Product systems
            </a>
            <a
              className="secondary"
              href="https://github.com/AutomatedEmpires/lakeandpine/tree/main/prototypes/recovered/2026-06-24"
            >
              Preserved prototype
            </a>
          </div>
        </div>
        <div className="hero-card">
          <p className="card-label">Conversion cycle</p>
          <ol>
            <li>Trust</li>
            <li>Estimate</li>
            <li>Book</li>
            <li>Repeat service</li>
            <li>Customer relationship</li>
          </ol>
        </div>
      </section>

      <section className="content-grid" id="systems">
        <article className="panel">
          <p className="section-label">Recovered product truth</p>
          <h2>What the prototype already proved</h2>
          <ul>
            {productSystems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <p className="section-label">Initial service architecture</p>
          <h2>What the production app should support first</h2>
          <ul>
            {serviceLines.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="panel span-two">
          <p className="section-label">Architecture stance</p>
          <h2>Keep the system tight around the customer journey.</h2>
          <p>
            Lake and Pine is not a marketplace. The production stack should stay focused on visitor trust,
            estimating, scheduling, billing, and repeat-service retention while using the same engineering
            standards as the rest of AutomatedEmpires.
          </p>
        </article>
      </section>
    </main>
  );
}