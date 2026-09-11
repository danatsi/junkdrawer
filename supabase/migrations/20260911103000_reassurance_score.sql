-- Reassurance score: "will I like this book, 0-10" — the read-tagged
-- counterpart to imdb_rating on watch-tagged rows.
--
-- There's no external API to ask, unlike TMDb/OMDb for films: the answer
-- depends on one fixed personal taste profile, so Gemini reasons it out
-- itself as part of the same call that already writes tags and summary (see
-- lib/gemini.ts). Null for anything that isn't a specific book.
alter table links add column if not exists reassurance_score smallint
  check (reassurance_score is null or reassurance_score between 0 and 10);
