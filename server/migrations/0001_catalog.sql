CREATE TABLE catalog_entries (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('film', 'series', 'collection')),
  publication_status text NOT NULL CHECK (publication_status IN ('draft', 'published')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  normalized_title text NOT NULL,
  synopsis text NOT NULL,
  release_year integer CHECK (release_year IS NULL OR release_year BETWEEN 1888 AND 2200),
  release_date date,
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  imdb_id text,
  tmdb_id bigint,
  content_fingerprint text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'film' OR duration_minutes IS NOT NULL),
  CHECK (kind <> 'series' OR duration_minutes IS NULL),
  CHECK (kind = 'collection' OR publication_status <> 'published' OR jsonb_array_length(payload->'distributionRights') > 0)
);

CREATE UNIQUE INDEX catalog_entries_content_identity_uq
  ON catalog_entries (kind, normalized_title, release_year, content_fingerprint)
  WHERE release_year IS NOT NULL;
CREATE UNIQUE INDEX catalog_entries_imdb_id_uq ON catalog_entries (lower(imdb_id)) WHERE imdb_id IS NOT NULL;
CREATE UNIQUE INDEX catalog_entries_tmdb_id_uq ON catalog_entries (tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX catalog_entries_browse_idx ON catalog_entries (publication_status, kind, release_date DESC NULLS LAST, normalized_title);
CREATE INDEX catalog_entries_payload_gin_idx ON catalog_entries USING gin (payload jsonb_path_ops);

CREATE TABLE catalog_genres (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  slug text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text
);

CREATE TABLE catalog_entry_genres (
  entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
  genre_id text NOT NULL REFERENCES catalog_genres(id) ON DELETE RESTRICT,
  PRIMARY KEY (entry_id, genre_id)
);
CREATE INDEX catalog_entry_genres_genre_idx ON catalog_entry_genres (genre_id, entry_id);

CREATE TABLE catalog_actors (
  entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  biography text,
  image_url text,
  PRIMARY KEY (entry_id, actor_id)
);

CREATE TABLE catalog_characters (
  entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
  character_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description text,
  PRIMARY KEY (entry_id, character_id)
);

CREATE TABLE catalog_character_actors (
  entry_id text NOT NULL,
  character_id text NOT NULL,
  actor_id text NOT NULL,
  PRIMARY KEY (entry_id, character_id, actor_id),
  FOREIGN KEY (entry_id, character_id) REFERENCES catalog_characters(entry_id, character_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id, actor_id) REFERENCES catalog_actors(entry_id, actor_id) ON DELETE RESTRICT
);

CREATE TABLE catalog_entry_cast (
  entry_id text NOT NULL,
  actor_id text NOT NULL,
  PRIMARY KEY (entry_id, actor_id),
  FOREIGN KEY (entry_id, actor_id) REFERENCES catalog_actors(entry_id, actor_id) ON DELETE CASCADE
);

CREATE TABLE catalog_seasons (
  entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
  season_id text NOT NULL,
  season_number integer NOT NULL CHECK (season_number > 0),
  title text,
  PRIMARY KEY (entry_id, season_id),
  UNIQUE (entry_id, season_number)
);

CREATE TABLE catalog_episodes (
  entry_id text NOT NULL,
  season_id text NOT NULL,
  episode_id text NOT NULL,
  episode_number integer NOT NULL CHECK (episode_number > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  synopsis text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  release_year integer CHECK (release_year IS NULL OR release_year BETWEEN 1888 AND 2200),
  release_date date,
  PRIMARY KEY (entry_id, episode_id),
  UNIQUE (entry_id, season_id, episode_number),
  FOREIGN KEY (entry_id, season_id) REFERENCES catalog_seasons(entry_id, season_id) ON DELETE CASCADE
);
CREATE INDEX catalog_episodes_order_idx ON catalog_episodes (entry_id, season_id, episode_number);

CREATE TABLE catalog_episode_cast (
  entry_id text NOT NULL,
  episode_id text NOT NULL,
  actor_id text NOT NULL,
  PRIMARY KEY (entry_id, episode_id, actor_id),
  FOREIGN KEY (entry_id, episode_id) REFERENCES catalog_episodes(entry_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id, actor_id) REFERENCES catalog_actors(entry_id, actor_id) ON DELETE RESTRICT
);

CREATE TABLE catalog_episode_characters (
  entry_id text NOT NULL,
  episode_id text NOT NULL,
  character_id text NOT NULL,
  PRIMARY KEY (entry_id, episode_id, character_id),
  FOREIGN KEY (entry_id, episode_id) REFERENCES catalog_episodes(entry_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id, character_id) REFERENCES catalog_characters(entry_id, character_id) ON DELETE RESTRICT
);

CREATE TABLE catalog_distribution_rights (
  entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
  right_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  streaming_allowed boolean NOT NULL,
  download_allowed boolean NOT NULL,
  PRIMARY KEY (entry_id, right_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX catalog_rights_active_idx ON catalog_distribution_rights (entry_id, starts_at, ends_at) WHERE streaming_allowed;

CREATE TABLE catalog_right_territories (
  entry_id text NOT NULL,
  right_id text NOT NULL,
  territory_code text NOT NULL CHECK (territory_code = 'WORLDWIDE' OR territory_code ~ '^[A-Z]{2}$'),
  PRIMARY KEY (entry_id, right_id, territory_code),
  FOREIGN KEY (entry_id, right_id) REFERENCES catalog_distribution_rights(entry_id, right_id) ON DELETE CASCADE
);

CREATE TABLE catalog_right_platforms (
  entry_id text NOT NULL,
  right_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'tv')),
  PRIMARY KEY (entry_id, right_id, platform),
  FOREIGN KEY (entry_id, right_id) REFERENCES catalog_distribution_rights(entry_id, right_id) ON DELETE CASCADE
);