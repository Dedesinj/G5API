'use strict';

var dbm;
var type;
var seed;

exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

// veto_first was VARCHAR(5): "random" (who chooses the veto order is decided by Rock-Paper-Scissors) did not fit.
exports.up = function (db) {
  return db.runSql('ALTER TABLE `match` MODIFY veto_first VARCHAR(10) NULL;');
};

exports.down = function (db) {
  return db.runSql("UPDATE `match` SET veto_first = 'team1' WHERE veto_first = 'random';")
    .then(() => db.runSql('ALTER TABLE `match` MODIFY veto_first VARCHAR(5) NULL;'));
};

exports._meta = {
  version: 35
};