CREATE TABLE contact(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  nick_name TEXT,
  remark TEXT,
  alias TEXT
);
CREATE TABLE chat_room(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL
);
CREATE TABLE chatroom_member(
  room_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  room_nickname TEXT
);
INSERT INTO contact VALUES
  (1, 'wxid_self_fixture', 'Self Fixture', '', ''),
  (2, 'wxid_friend_fixture', 'Friend Fixture', 'Friend Remark', ''),
  (3, 'wxid_member_fixture', 'Member Fixture', '', 'member-alias'),
  (4, 'room_fixture@chatroom', 'Fixture Group', '', '');
INSERT INTO chat_room VALUES (10, 'room_fixture@chatroom');
INSERT INTO chatroom_member VALUES (10, 3, 'Room Member');
