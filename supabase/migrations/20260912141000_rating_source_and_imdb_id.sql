-- Where a rating came from, and the id needed to go and read it.
--
-- `imdb_rating` had exactly one source: OMDb. That service goes quiet for at
-- least four ordinary reasons — no API key, no imdb_id from TMDb, a literal
-- "N/A" for anything recent or any per-season TV entry, and a 1,000/day quota
-- — and any one of them left the row with no rating at all, while TMDb's own
-- average sat unread in the search response enrichment had already paid for.
--
-- So the rating now falls back to TMDb's number, and the row records which
-- service it got. The two genuinely read differently (spec §3.4), so this is
-- not cosmetic: it decides what the badge is called, and it keeps the app from
-- presenting a TMDb average as though IMDb had said it.
--
-- `imdb_id` is stored separately because it's useful even when neither service
-- gave us a rating: it's what makes the badge a link to the title on IMDb.
-- TMDb hands it over whenever it recognises the title at all.
--
-- Nullable and additive: existing rows keep whatever rating they already have
-- and read as 'imdb', which is where every rating stored before today came
-- from. Backfill posters and the widened ratings with POST /api/backfill-watch.
alter table links add column if not exists imdb_id text;
alter table links add column if not exists rating_source text
  check (rating_source is null or rating_source in ('imdb', 'tmdb'));

-- Everything already in the table predates the TMDb fallback, so its rating
-- can only have come from OMDb.
update links set rating_source = 'imdb' where imdb_rating is not null and rating_source is null;
