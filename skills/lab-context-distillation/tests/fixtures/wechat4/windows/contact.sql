CREATE TABLE Contact(
  contactId INTEGER PRIMARY KEY,
  userName TEXT UNIQUE NOT NULL,
  nickName TEXT,
  remarkName TEXT,
  aliasName TEXT
);
CREATE TABLE ChatRoom(
  roomId INTEGER PRIMARY KEY,
  userName TEXT UNIQUE NOT NULL
);
CREATE TABLE ChatRoomMember(
  roomId INTEGER NOT NULL,
  memberId INTEGER NOT NULL,
  roomNickName TEXT
);
INSERT INTO Contact VALUES
  (1, 'wxid_self_fixture', 'Self Fixture', '', ''),
  (2, 'wxid_friend_fixture', 'Friend Fixture', 'Friend Remark', ''),
  (3, 'wxid_member_fixture', 'Member Fixture', '', 'member-alias'),
  (4, 'room_fixture@chatroom', 'Fixture Group', '', '');
INSERT INTO ChatRoom VALUES (10, 'room_fixture@chatroom');
INSERT INTO ChatRoomMember VALUES (10, 3, 'Room Member');
