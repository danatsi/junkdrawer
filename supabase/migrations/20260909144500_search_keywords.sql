-- Bilingual search vocabulary (spec §6 q4).
--
-- A row saved from an English retailer has to be findable by the Hebrew word
-- for the thing, and vice versa. Nothing in the scraped page or the generated
-- title carries both, so enrichment now asks for the terms explicitly and
-- stores them here: category words, synonyms and brand, in Hebrew and English
-- regardless of the page's own language.
--
-- Not shown anywhere in the UI — it exists only to be matched against. Kept
-- out of `tags` deliberately: tags are a fixed vocabulary the chip bar renders
-- and a dozen search terms would swamp it.
alter table links add column if not exists keywords text[] not null default '{}';

-- Only read back with the row it belongs to, so no index: the filter is
-- client-side over the already-fetched list (PLAN §3 Phase 6).
