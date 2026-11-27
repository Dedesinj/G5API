/**
 * Routes match updates to the bracket provider of the match's season.
 *
 * A season is imported either from Challonge or from Toornament; each provider
 * has its own reporting behaviour, so callers only signal what happened.
 *
 * @module services/tournament
 */

import { RowDataPacket } from "mysql2";

import { db } from "./db.js";
import update_challonge_match from "./challonge.js";
import { update_toornament_match, TournamentEvent } from "./toornament.js";

export type { TournamentEvent };

/** Reports a match event to the bracket of its season, if any. Never throws.
 * @param {TournamentEvent} event - `veto` (maps known), `live` (round score), `map_end` or `series_end`.
 * @param {number | string} match_id - The internal match ID.
 * @param {number} season_id - The internal season ID.
 * @param {number} team1_id - The internal ID of the first team.
 * @param {number} team2_id - The internal ID of the second team.
 * @param {number} num_maps - The number of maps of the match.
 * @param {string | null} [winner=null] - `team1`, `team2` or `none` at series end.
 */
export default async function update_tournament_match(
  event: TournamentEvent,
  match_id: number | string | null,
  season_id: number,
  team1_id: number,
  team2_id: number,
  num_maps: number,
  winner: string | null = null
): Promise<void> {
  try {
    if (match_id == null) return;
    const season: RowDataPacket[] = await db.query(
      "SELECT is_challonge, is_toornament FROM season WHERE id = ?",
      [season_id]
    );
    if (!season[0]) return;

    if (season[0].is_toornament) {
      const report = update_toornament_match(event, match_id, season_id, winner);
      // Round and veto updates must not delay the answer to the game server.
      if (event !== "live" && event !== "veto") await report;
      return;
    }

    // Challonge has no maps to set, gets the live round score of a BO1, and the series score after each map otherwise.
    if (event === "veto") return;
    if (event === "live" && num_maps != 1) return;
    if (event === "map_end" && num_maps == 1) return;
    await update_challonge_match(match_id, season_id, team1_id, team2_id, num_maps, winner);
  } catch (err) {
    console.error(`Failed to update tournament match ${match_id}: ${err}`);
  }
}

/** Reports the maps known so far (veto picks, imposed maps) to the bracket of a match. Never throws.
 * @param {number | string} match_id - The internal match ID.
 */
export async function report_tournament_maps(match_id: number | string): Promise<void> {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT season_id, team1_id, team2_id, max_maps FROM `match` WHERE id = ?",
      [match_id]
    );
    if (!rows[0]?.season_id) return;
    await update_tournament_match(
      "veto",
      match_id,
      rows[0].season_id,
      rows[0].team1_id,
      rows[0].team2_id,
      rows[0].max_maps
    );
  } catch (err) {
    console.error(`Failed to report the maps of match ${match_id}: ${err}`);
  }
}
