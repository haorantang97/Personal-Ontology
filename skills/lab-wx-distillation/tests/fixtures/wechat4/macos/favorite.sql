CREATE TABLE FavoriteItem(
  local_id INTEGER PRIMARY KEY,
  create_time INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  source_username TEXT
);
INSERT INTO FavoriteItem VALUES (1, 1700000100, 'Saved fixture', 'Synthetic saved context', 'wxid_friend_fixture');
