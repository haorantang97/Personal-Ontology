CREATE TABLE "{DIRECT_TABLE}"(
  local_id INTEGER PRIMARY KEY,
  server_id TEXT,
  create_time INTEGER NOT NULL,
  sort_seq INTEGER NOT NULL,
  local_type INTEGER NOT NULL,
  real_sender_id TEXT,
  message_content TEXT,
  source TEXT,
  is_sender INTEGER NOT NULL
);
CREATE TABLE "{GROUP_TABLE}"(
  local_id INTEGER PRIMARY KEY,
  server_id TEXT,
  create_time INTEGER NOT NULL,
  sort_seq INTEGER NOT NULL,
  local_type INTEGER NOT NULL,
  real_sender_id TEXT,
  message_content TEXT,
  source TEXT,
  is_sender INTEGER NOT NULL
);
INSERT INTO "{DIRECT_TABLE}" VALUES
  (1, 'srv-1', 1700000000, 100, 1, 'wxid_self_fixture', 'I compare options with Friend Fixture (wxid_friend_fixture).', '', 1),
  (2, 'srv-2', 1700000000, 101, 49, 'wxid_friend_fixture', '<msg><appmsg><type>57</type><title>My reply</title><refermsg><displayname>Friend Fixture</displayname><content>Quoted fixture</content></refermsg></appmsg></msg>', '', 1),
  (3, 'srv-3', 1700000001, 102, 3, 'wxid_friend_fixture', '<msg><img md5="synthetic-image" filename="synthetic-image.jpg" /></msg>', '', 0),
  (4, 'srv-4', 1700000002, 103, 34, 'wxid_friend_fixture', '<msg><voicemsg filename="synthetic-voice.silk" /></msg>', '', 0),
  (5, 'srv-5', 1700000003, 104, 49, 'wxid_self_fixture', '<msg><appmsg><type>6</type><title>fixture-document.pdf</title><des>Synthetic attachment</des></appmsg></msg>', '', 1);
INSERT INTO "{GROUP_TABLE}" VALUES
  (1, 'srv-g1', 1700000010, 200, 1, '42', 'wxid_member_fixture:\nGroup-authored fixture', '', 0),
  (2, 'srv-g2', 1700000011, 201, 49, 'wxid_self_fixture', '<msg><appmsg><type>19</type><title>Forwarded fixture bundle</title><des>Two synthetic items</des></appmsg></msg>', '', 1);
