-- A row's image_url can now be one of two different things: a real product or
-- article photo scraped from the page, or the site's favicon standing in for
-- one. They need opposite rendering — a photo is cropped to fill the square, a
-- favicon must be contained and padded or it looks stretched and broken — so
-- the row has to be able to tell them apart.
alter table links add column if not exists image_kind text
  check (image_kind in ('photo', 'icon'));
