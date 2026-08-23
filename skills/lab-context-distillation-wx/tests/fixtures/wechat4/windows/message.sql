CREATE TABLE "{DIRECT_TABLE}"(
  localId INTEGER PRIMARY KEY,
  serverId TEXT,
  createTime INTEGER NOT NULL,
  sortSeq INTEGER NOT NULL,
  localType INTEGER NOT NULL,
  senderId TEXT,
  content TEXT,
  source TEXT,
  isSend INTEGER NOT NULL
);
CREATE TABLE "{GROUP_TABLE}"(
  localId INTEGER PRIMARY KEY,
  serverId TEXT,
  createTime INTEGER NOT NULL,
  sortSeq INTEGER NOT NULL,
  localType INTEGER NOT NULL,
  senderId TEXT,
  content TEXT,
  source TEXT,
  isSend INTEGER NOT NULL
);
INSERT INTO "{DIRECT_TABLE}" VALUES
  (1, 'srv-w1', 1700000000, 100, 1, 'wxid_self_fixture', 'Windows self fixture', '', 1),
  (2, 'srv-w2', 1700000001, 101, 1, 'wxid_friend_fixture', 'Windows friend fixture', '', 0);
INSERT INTO "{GROUP_TABLE}" VALUES
  (1, 'srv-wg1', 1700000010, 200, 1, '99', 'wxid_member_fixture:\nWindows group fixture', '', 0);
