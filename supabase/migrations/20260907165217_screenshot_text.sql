-- Screenshots (spec §5.3). The vision call OCRs whatever text is in the image;
-- `description` holds the short human-readable summary, so the raw extracted
-- text needs its own column to stay searchable without crowding the row.
alter table links add column if not exists extracted_text text;
