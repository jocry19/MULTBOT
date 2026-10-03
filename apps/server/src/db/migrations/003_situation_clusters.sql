-- Historical situation clusters (k-means over research samples) with outcome statistics.
CREATE TABLE situation_clusters (
  id            BIGSERIAL PRIMARY KEY,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id        TEXT NOT NULL,
  cluster_index INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  features      JSONB NOT NULL,     -- feature set used
  centroid      JSONB NOT NULL,     -- feature → centroid value (original units)
  description   JSONB NOT NULL,     -- most distinctive features with direction
  stats         JSONB NOT NULL,     -- per horizon outcome statistics
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ
);
CREATE INDEX situation_clusters_run_idx ON situation_clusters (run_at DESC);
