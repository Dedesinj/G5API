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
  return db.runSql('ALTER TABLE season ADD COLUMN discord_live_webhook_url VARCHAR(512) NULL AFTER discord_webhook_url;')
    .then(() => db.runSql('ALTER TABLE season ADD COLUMN discord_results_webhook_url VARCHAR(512) NULL AFTER discord_live_webhook_url;'))
    .then(() => db.runSql('ALTER TABLE `match` ADD COLUMN discord_live_message_id VARCHAR(32) NULL AFTER discord_message_id;'))
    .then(() => db.runSql('ALTER TABLE `match` ADD COLUMN discord_result_message_id VARCHAR(32) NULL AFTER discord_live_message_id;'));
};

exports.down = function (db) {
  return db.removeColumn('match', 'discord_result_message_id')
    .then(() => db.removeColumn('match', 'discord_live_message_id'))
    .then(() => db.removeColumn('season', 'discord_results_webhook_url'))
    .then(() => db.removeColumn('season', 'discord_live_webhook_url'));
};

exports._meta = {
  version: 34
};