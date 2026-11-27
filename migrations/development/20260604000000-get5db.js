'use strict';

var dbm;
var type;
var seed;

exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function (db) {
  return db.runSql('ALTER TABLE season ADD COLUMN discord_webhook_url VARCHAR(512) NULL;')
    .then(() => db.runSql('ALTER TABLE `match` ADD COLUMN discord_message_id VARCHAR(32) NULL;'));
};

exports.down = function (db) {
  return db.removeColumn('match', 'discord_message_id')
    .then(() => db.removeColumn('season', 'discord_webhook_url'));
};

exports._meta = {
  version: 33
};