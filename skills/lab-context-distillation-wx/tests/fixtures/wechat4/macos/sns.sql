CREATE TABLE SnsFeed(
  local_id INTEGER PRIMARY KEY,
  create_time INTEGER NOT NULL,
  author_username TEXT,
  content TEXT,
  media_json TEXT
);
INSERT INTO SnsFeed VALUES (1, 1700000200, 'wxid_self_fixture', 'Synthetic moment caption', '["moment-image.jpg"]');
