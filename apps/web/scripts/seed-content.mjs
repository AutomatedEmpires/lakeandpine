// Seeds/refreshes CONTENT: service areas (real product config) and placeholder
// reviews (marked is_dev_seed + source='placeholder' so ops:purge-dev-seed
// removes them before real reviews go live). Idempotent.
import { connect } from "./_db.mjs";
import { placeholderReviews, serviceAreas } from "./content/service-areas.mjs";

const sql = connect();

for (const area of serviceAreas) {
  await sql`
    insert into service_areas
      (slug, city, state, seo_phrase, headline, intro, neighborhoods, highlights, faqs, lat, lng, sort)
    values
      (${area.slug}, ${area.city}, ${area.state}, ${area.seo_phrase}, ${area.headline},
       ${area.intro}, ${area.neighborhoods}, ${sql.json(area.highlights)},
       ${sql.json(area.faqs)}, ${area.lat}, ${area.lng}, ${area.sort})
    on conflict (slug) do update set
      city = excluded.city, state = excluded.state, seo_phrase = excluded.seo_phrase,
      headline = excluded.headline, intro = excluded.intro,
      neighborhoods = excluded.neighborhoods, highlights = excluded.highlights,
      faqs = excluded.faqs, lat = excluded.lat, lng = excluded.lng, sort = excluded.sort`;
}
console.log(`service_areas: ${serviceAreas.length} upserted`);

let inserted = 0;
for (const review of placeholderReviews) {
  const existing = await sql`
    select 1 from reviews
    where author_name = ${review.name} and body = ${review.body}`;
  if (existing.length === 0) {
    await sql`
      insert into reviews (author_initial, author_name, city, body, rating, source, is_dev_seed)
      values (${review.initial}, ${review.name}, ${review.city}, ${review.body},
              ${review.rating}, 'placeholder', true)`;
    inserted += 1;
  }
}
console.log(`reviews: ${inserted} placeholder rows inserted`);

await sql.end();
