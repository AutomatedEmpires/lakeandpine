-- Product catalog content, idempotent. Values are the recovered-prototype anchors.
-- (No BEFORE INSERT triggers exist on these tables, so ON CONFLICT upserts are safe here.)

insert into services (id, title, icon, blurb, price_label, starting_price_cents, tags, bookable, sort) values
  ('essential', 'Essential Home Reset', '🪄',
   'Recurring maintenance that makes the home feel reset: kitchen, bathrooms, dusting, floors, trash, beds, and surfaces.',
   'starting at $139', 13900, '{"Recurring","Most popular","Family homes"}', true, 1),
  ('deep', 'Pine & Polish Deep Clean', '✨',
   'A detailed top-to-bottom clean for buildup, seasonal resets, first cleans, hosting, or holidays.',
   'starting at $299', 29900, '{"Detail work","Baseboards","Fixtures"}', true, 2),
  ('move', 'Move In / Move Out Detail', '📦',
   'Empty-home cleaning for lease turns, selling, buying, or starting fresh in a new place.',
   'starting at $369', 36900, '{"Appliances","Cabinets","Lease ready"}', true, 3),
  ('rental', 'Lakehouse Turnover', '🔑',
   'Guest-ready vacation rental turnover with linens, restock checklist, and photo-ready polish.',
   'starting at $125', 12500, '{"Airbnb","Same-day","Checklist"}', true, 4),
  ('office', 'Small Office Refresh', '🏢',
   'After-hours cleaning for offices, studios, salons, and small commercial spaces.',
   'custom starting quote', null, '{"After-hours","Restrooms","Weekly"}', false, 5),
  ('addons', 'Add-On Studio', '🧺',
   'Inside fridge, oven, laundry, interior windows, organization, and special request modules.',
   'starting at $25', 2500, '{"Fridge","Oven","Laundry"}', false, 6)
on conflict (id) do update set
  title = excluded.title, icon = excluded.icon, blurb = excluded.blurb,
  price_label = excluded.price_label, starting_price_cents = excluded.starting_price_cents,
  tags = excluded.tags, bookable = excluded.bookable, sort = excluded.sort;

insert into addons (id, title, price_label, price_cents, sort) values
  ('fridge', 'Inside fridge', '+$25', 2500, 1),
  ('oven', 'Inside oven', '+$25', 2500, 2),
  ('laundry', 'Laundry', '+$25', 2500, 3),
  ('windows', 'Interior windows', 'from $8/window', null, 4),
  ('organization', 'Organization', 'from $55/hr', null, 5)
on conflict (id) do update set
  title = excluded.title, price_label = excluded.price_label,
  price_cents = excluded.price_cents, sort = excluded.sort;

insert into plans (id, name, price_cents, save_label, popular, features, sort) values
  ('weekly', 'Weekly', 11200, 'starting at · save up to 20%', true,
   '{"Priority scheduling","Consistent reset","Best for busy homes"}', 1),
  ('biweekly', 'Bi-weekly', 13900, 'starting at · save up to 15%', false,
   '{"Most popular cadence","Fresh without overkill","Easy pause/reschedule"}', 2),
  ('monthly', 'Monthly', 15900, 'starting at · save up to 10%', false,
   '{"Maintenance reset","Flexible schedule","Good for lighter use"}', 3),
  ('onetime', 'One-time', 17900, 'starting at · no plan', false,
   '{"Special events","Guest prep","No commitment"}', 4)
on conflict (id) do update set
  name = excluded.name, price_cents = excluded.price_cents, save_label = excluded.save_label,
  popular = excluded.popular, features = excluded.features, sort = excluded.sort;

insert into faqs (question, answer, sort)
select q, a, s from (values
  ('Do you bring your own cleaning supplies?',
   'Yes. Eco-conscious supplies are included unless you request specific products. Unscented and pet-aware options can be saved in your home notes.', 1),
  ('Are cleaners background-checked?',
   'Yes. Every cleaner is vetted, background-checked, insured, and bonded.', 2),
  ('Are prices fixed?',
   'No. Displayed prices are starting anchors. Final pricing depends on home size, condition, pets, frequency, add-ons, and special requests.', 3),
  ('Can I schedule online?',
   'Yes. Online booking covers service selection, home details, add-ons, date and time selection, contact info, review, and confirmation.', 4),
  ('Do you clean with pets at home?',
   'Yes. Add pet names, instructions, rooms, and product preferences during booking or in your dashboard.', 5),
  ('What is the guarantee?',
   'A 24-hour make-right window: if something is not completed to the agreed scope, we return and fix it.', 6)
) as v(q, a, s)
where not exists (select 1 from faqs where faqs.question = v.q);
