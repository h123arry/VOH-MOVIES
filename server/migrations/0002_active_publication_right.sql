ALTER TABLE catalog_entries
  ADD CONSTRAINT catalog_entries_published_web_right_chk
  CHECK (
    kind = 'collection'
    OR publication_status <> 'published'
    OR payload->'distributionRights' @> '[{"streamingAllowed": true, "platforms": ["web"]}]'::jsonb
  );