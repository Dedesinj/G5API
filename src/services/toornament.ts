/**
 * Toornament organizer API client.
 *
 * Each user stores the credentials of their own Toornament application (API key,
 * client ID and client secret). Results are always reported with the
 * credentials of the season owner, so matches of an imported season update the
 * bracket whoever plays or administers them.
 *
 * @module services/toornament
 */

import fetch, { RequestInit, Response } from "node-fetch";
import { RowDataPacket } from "mysql2";

import Utils from "../utility/utils.js";
import { db } from "./db.js";
import GlobalEmitter from "../utility/emitter.js";

import {
  ToornamentCredentials,
  ToornamentGame,
  ToornamentMatch,
  ToornamentOpponentUpdate,
  ToornamentParticipant,
  ToornamentResult,
  ToornamentRound,
  ToornamentStage,
  ToornamentTokenResponse,
  ToornamentTournament
} from "../types/toornament/ToornamentTypes.js";

const TOKEN_URL = "https://api.toornament.com/oauth/v2/token";
const BASE_URL = "https://api.toornament.com/organizer/v2";
const SCOPES = "organizer:view organizer:result organizer:participant";
const PARTICIPANTS_PAGE_SIZE = 50;
const TOURNAMENTS_PAGE_SIZE = 50;
const STRUCTURE_PAGE_SIZE = 50;
const MATCHES_PAGE_SIZE = 100;
/** Guards against an unbounded loop if the API ever stops shrinking pages. */
const MAX_PAGES = 100;
/** Refresh tokens a little before they really expire. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Thrown for any non-2xx Toornament response. Never carries credentials. */
export class ToornamentApiError extends Error {
  constructor(public status: number, public endpoint: string, body: string) {
    super(`Toornament API returned ${status} for ${endpoint}: ${body}`);
    this.name = "ToornamentApiError";
  }
}

/** Extracts a tournament ID from a raw ID or any Toornament tournament URL.
 *
 * Accepts e.g. `8126489237641232384`,
 * `https://play.toornament.com/en_GB/tournaments/8126489237641232384/` or
 * `https://organizer.toornament.com/tournaments/8126489237641232384/settings/`.
 * @param {string} identifier - The raw tournament ID or URL.
 */
export function parseToornamentId(identifier: string): string {
  const raw: string = String(identifier ?? "").trim();
  const fromUrl: RegExpMatchArray | null = raw.match(/\/tournaments\/(\d+)/i);
  if (fromUrl) return fromUrl[1];
  if (/^\d+$/.test(raw)) return raw;
  throw new Error(`"${raw}" is not a valid Toornament tournament ID or URL.`);
}

/** Whether a Toornament discipline ID designates Counter-Strike 2. */
export function isCs2Discipline(discipline: string | null | undefined): boolean {
  return /counter[-_ ]?strike[-_ ]?2|^cs[-_ ]?2$/i.test(String(discipline ?? ""));
}

/** Cached access tokens, keyed by client ID. Tokens live ~25h. */
const tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

/** Toornament match resolved for an internal match, to avoid a lookup per round. */
interface ResolvedMatch {
  toornamentMatchId: string;
  sides: { team1: number; team2: number };
}
const resolvedMatches: Map<string, ResolvedMatch> = new Map();

/** Last payload sent per game / match, so unchanged data is never sent twice. */
const sentPayloads: Map<string, string> = new Map();

/** Per-match queue and pending live update, as round events arrive in bursts. */
const reportQueues: Map<string, Promise<void>> = new Map();
const pendingLiveReports: Set<string> = new Set();

export class Toornament {
  constructor(private credentials: ToornamentCredentials) {
    if (!credentials.apiKey || !credentials.clientId || !credentials.clientSecret) {
      throw new Error("Toornament credentials are incomplete.");
    }
  }

  /** Builds a client from a user's stored credentials.
   * @param {number} userId - The internal user ID.
   */
  static async forUser(userId: number): Promise<Toornament> {
    const rows: RowDataPacket[] = await db.query(
      "SELECT toornament_api_key, toornament_client_id, toornament_client_secret FROM user WHERE id = ?",
      [userId]
    );
    const row = rows[0];
    const credentials: ToornamentCredentials = {
      apiKey: (row && Utils.decrypt(row.toornament_api_key)) || "",
      clientId: (row && Utils.decrypt(row.toornament_client_id)) || "",
      clientSecret: (row && Utils.decrypt(row.toornament_client_secret)) || ""
    };
    if (!credentials.apiKey || !credentials.clientId || !credentials.clientSecret) {
      throw new Error("No Toornament credentials provided for user.");
    }
    return new Toornament(credentials);
  }

  /** Requests a fresh token, proving the credentials are valid. */
  async testCredentials(): Promise<void> {
    tokenCache.delete(this.credentials.clientId);
    await this.getToken();
  }

  /** Fetches a tournament.
   * @param {string} tournamentId - The Toornament tournament ID.
   */
  async getTournament(tournamentId: string): Promise<ToornamentTournament> {
    return this.request<ToornamentTournament>(
      `/tournaments/${encodeURIComponent(tournamentId)}`
    );
  }

  /** Lists every non-archived tournament of the application, most recent first. */
  async listTournaments(): Promise<ToornamentTournament[]> {
    return this.paginate<ToornamentTournament>(
      "/tournaments?sort=scheduled_desc",
      "tournaments",
      TOURNAMENTS_PAGE_SIZE
    );
  }

  /** Lists every stage of a tournament.
   * @param {string} tournamentId - The Toornament tournament ID.
   */
  async listStages(tournamentId: string): Promise<ToornamentStage[]> {
    return this.paginate<ToornamentStage>(
      `/stages?tournament_ids=${encodeURIComponent(tournamentId)}`,
      "stages",
      STRUCTURE_PAGE_SIZE
    );
  }

  /** Lists every round of a tournament.
   * @param {string} tournamentId - The Toornament tournament ID.
   */
  async listRounds(tournamentId: string): Promise<ToornamentRound[]> {
    return this.paginate<ToornamentRound>(
      `/rounds?tournament_ids=${encodeURIComponent(tournamentId)}`,
      "rounds",
      STRUCTURE_PAGE_SIZE
    );
  }

  /** Fetches a single match.
   * @param {string} matchId - The Toornament match ID.
   */
  async getMatch(matchId: string): Promise<ToornamentMatch> {
    return this.request<ToornamentMatch>(`/matches/${encodeURIComponent(matchId)}`);
  }

  /** Lists the games (maps) of a match.
   * @param {string} matchId - The Toornament match ID.
   */
  async listGames(matchId: string): Promise<ToornamentGame[]> {
    return this.paginate<ToornamentGame>(
      `/matches/${encodeURIComponent(matchId)}/games`,
      "games",
      STRUCTURE_PAGE_SIZE
    );
  }

  /** Lists every participant of a tournament.
   * @param {string} tournamentId - The Toornament tournament ID.
   */
  async listParticipants(tournamentId: string): Promise<ToornamentParticipant[]> {
    return this.paginate<ToornamentParticipant>(
      `/participants?tournament_ids=${encodeURIComponent(tournamentId)}&sort=alphabetic`,
      "participants",
      PARTICIPANTS_PAGE_SIZE
    );
  }

  /** Lists matches of a tournament, optionally filtered by status and participants.
   * @param {string} tournamentId - The Toornament tournament ID.
   * @param {Object} [opts] - `statuses` and `participantIds` filters.
   */
  async listMatches(
    tournamentId: string,
    opts: { statuses?: string[]; participantIds?: string[] } = {}
  ): Promise<ToornamentMatch[]> {
    const query: string[] = [
      `tournament_ids=${encodeURIComponent(tournamentId)}`,
      "sort=structure"
    ];
    if (opts.statuses?.length) query.push(`statuses=${opts.statuses.join(",")}`);
    if (opts.participantIds?.length)
      query.push(`participant_ids=${opts.participantIds.map(encodeURIComponent).join(",")}`);
    let matches: ToornamentMatch[] = await this.paginate<ToornamentMatch>(
      `/matches?${query.join("&")}`,
      "matches",
      MATCHES_PAGE_SIZE
    );
    // participant_ids matches either side; keep only matches between all of them.
    if (opts.participantIds?.length) {
      matches = matches.filter((match) => {
        const ids: string[] = (match.opponents ?? []).map((opp) =>
          String(opp.participant?.id ?? "")
        );
        return opts.participantIds!.every((id) => ids.includes(id));
      });
    }
    return matches;
  }

  /** Updates the outcome of a match.
   * @param {string} matchId - The Toornament match ID.
   * @param {ToornamentOpponentUpdate[]} opponents - One entry per side.
   */
  async updateMatch(matchId: string, opponents: ToornamentOpponentUpdate[]): Promise<void> {
    await this.request(`/matches/${encodeURIComponent(matchId)}`, {
      method: "PATCH",
      body: JSON.stringify({ opponents })
    });
  }

  /** Updates one game of a match: outcome, status and/or map.
   *
   * The `map` property only exists for disciplines that define it, so the game
   * is retried without properties if Toornament rejects them. A game with no
   * opponents and no status (a planned map only) is skipped in that case.
   * @param {string} matchId - The Toornament match ID.
   * @param {number} gameNumber - The game number, starting at 1.
   * @param {ToornamentOpponentUpdate[] | null} opponents - One entry per side, or null to leave the score untouched.
   * @param {string | null} mapName - The map played or planned, if known.
   * @param {string} [status] - `running` or `completed`; omitted to let Toornament decide.
   */
  async updateGame(
    matchId: string,
    gameNumber: number,
    opponents: ToornamentOpponentUpdate[] | null,
    mapName: string | null,
    status?: "running" | "completed"
  ): Promise<void> {
    const path: string = `/matches/${encodeURIComponent(matchId)}/games/${gameNumber}`;
    const body: Record<string, any> = {};
    if (opponents) body.opponents = opponents;
    if (status) body.status = status;
    if (mapName) {
      try {
        await this.request(path, {
          method: "PATCH",
          body: JSON.stringify({ ...body, properties: { map: mapName } })
        });
        return;
      } catch (err) {
        if (!(err instanceof ToornamentApiError) || err.status !== 400) throw err;
      }
    }
    if (!Object.keys(body).length) return;
    await this.request(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  private async getToken(): Promise<string> {
    const cached = tokenCache.get(this.credentials.clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const response: Response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        scope: SCOPES
      })
    });
    if (!response.ok) {
      const body: string = await response.text().catch(() => "");
      throw new ToornamentApiError(response.status, "/oauth/v2/token", body.substring(0, 500));
    }
    const data = (await response.json()) as ToornamentTokenResponse;
    if (!data.access_token) throw new Error("Toornament authentication failed.");
    tokenCache.set(this.credentials.clientId, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_MARGIN_MS
    });
    return data.access_token;
  }

  /** Issues an authenticated request, retrying once with a fresh token on 401.
   * @param {string} path - Endpoint path, with query string, relative to the organizer API.
   * @param {RequestInit} [init] - Additional fetch options.
   * @param {string} [range] - Value of the Range header for collection endpoints.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    range?: string,
    retried: boolean = false
  ): Promise<T> {
    const { response, body } = await this.rawRequest(path, init, range);
    if (response.status === 401 && !retried) {
      tokenCache.delete(this.credentials.clientId);
      return this.request<T>(path, init, range, true);
    }
    if (!response.ok) {
      throw new ToornamentApiError(response.status, path, body.substring(0, 500));
    }
    return (body ? JSON.parse(body) : undefined) as T;
  }

  private async rawRequest(
    path: string,
    init: RequestInit,
    range?: string
  ): Promise<{ response: Response; body: string }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": this.credentials.apiKey,
      Authorization: `Bearer ${await this.getToken()}`
    };
    if (range) headers.Range = range;
    const response: Response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    const body: string = await response.text().catch(() => "");
    return { response, body };
  }

  /** Walks every page of a collection endpoint using Range headers.
   * @param {string} path - Endpoint path, with query string.
   * @param {string} unit - The range unit of the endpoint (e.g. `matches`).
   * @param {number} pageSize - The maximum range size allowed by the endpoint.
   */
  private async paginate<T>(path: string, unit: string, pageSize: number): Promise<T[]> {
    const results: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from: number = page * pageSize;
      let items: T[];
      try {
        items = await this.request<T[]>(path, {}, `${unit}=${from}-${from + pageSize - 1}`);
      } catch (err) {
        // 416 means the range starts past the last item.
        if (err instanceof ToornamentApiError && err.status === 416) break;
        throw err;
      }
      results.push(...(items ?? []));
      if (!items || items.length < pageSize) break;
    }
    return results;
  }
}

export type TournamentEvent = "veto" | "live" | "map_end" | "series_end";

/** Maps planned for each game of a match, in order, when they are known.
 *
 * Imposed maps come from the map pool of a match without veto. With an in-game
 * veto they come from the picks so far, plus the decider once a single map of
 * the pool is left.
 */
async function getPlannedMaps(matchId: number | string, maxMaps: number): Promise<string[]> {
  const rows: RowDataPacket[] = await db.query(
    "SELECT skip_veto, veto_mappool FROM `match` WHERE id = ?",
    [matchId]
  );
  const pool: string[] = String(rows[0]?.veto_mappool ?? "")
    .replace(/,/g, " ")
    .split(" ")
    .filter(Boolean);
  if (rows[0]?.skip_veto) return pool.slice(0, maxMaps);

  const vetoes: RowDataPacket[] = await db.query(
    "SELECT map, pick_or_veto FROM veto WHERE match_id = ? ORDER BY id",
    [matchId]
  );
  const picks: string[] = vetoes.filter((v) => v.pick_or_veto === "pick").map((v) => v.map);
  const used: Set<string> = new Set(vetoes.map((v) => v.map));
  const left: string[] = pool.filter((map) => !used.has(map));
  if (picks.length === maxMaps - 1 && left.length === 1) picks.push(left[0]);
  return picks.slice(0, maxMaps);
}

/** Sends a payload unless the exact same one was already sent. */
async function sendOnce(key: string, payload: object, send: () => Promise<void>): Promise<void> {
  const serialized: string = JSON.stringify(payload);
  if (sentPayloads.get(key) === serialized) return;
  await send();
  sentPayloads.set(key, serialized);
}

/** Reports the state of a match to its Toornament bracket. Never throws.
 *
 * - every game played is reported with its score (live, round by round),
 *   result, status and map; games still to play get their map once known;
 * - the match score is kept up to date (round score for a BO1, maps won otherwise);
 * - at the end of the series the match results are set, which completes it on
 *   Toornament, and the season is closed once no pending or running match remains.
 *
 * Calls for a match run one after the other, live calls are coalesced, and data
 * that did not change since the last call is not sent again.
 * @param {TournamentEvent} event - What triggered the update.
 * @param {number | string} match_id - The internal match ID.
 * @param {number} season_id - The internal season ID.
 * @param {string | null} [winner=null] - `team1`, `team2` or `none` at series end.
 */
export function update_toornament_match(
  event: TournamentEvent,
  match_id: number | string,
  season_id: number,
  winner: string | null = null
): Promise<void> {
  const key: string = String(match_id);
  if (event === "live" || event === "veto") {
    if (pendingLiveReports.has(key)) return reportQueues.get(key) ?? Promise.resolve();
    pendingLiveReports.add(key);
  }
  const next: Promise<void> = (reportQueues.get(key) ?? Promise.resolve()).then(async () => {
    if (event === "live" || event === "veto") pendingLiveReports.delete(key);
    try {
      await reportToornamentMatch(event, match_id, season_id, winner);
    } catch (err) {
      // Never let a bracket update take down the match flow that triggered it.
      console.error(`Failed to update Toornament match for season ${season_id}: ${err}`);
    }
  });
  reportQueues.set(key, next);
  next.then(() => {
    if (reportQueues.get(key) === next) reportQueues.delete(key);
  });
  return next;
}

/** Finds the Toornament match of an internal match and which opponent is which team. */
async function resolveMatch(
  toornament: Toornament,
  tournamentId: string,
  matchKey: string,
  linkedMatchId: string | null,
  team1Participant: string,
  team2Participant: string
): Promise<ResolvedMatch | null> {
  const cached = resolvedMatches.get(matchKey);
  if (cached) return cached;
  let target: ToornamentMatch | undefined;
  if (linkedMatchId) {
    // Matches created from the season page are linked explicitly.
    target = await toornament.getMatch(linkedMatchId);
  } else {
    target = (
      await toornament.listMatches(tournamentId, {
        statuses: ["pending", "running"],
        participantIds: [team1Participant, team2Participant]
      })
    )[0];
  }
  if (!target) {
    console.warn(
      `No open Toornament match between ${team1Participant} and ${team2Participant} in tournament ${tournamentId}.`
    );
    return null;
  }
  // Admins may create the match with teams swapped; map sides by participant.
  const opponents = target.opponents ?? [];
  const numberOf = (participantId: string): number | undefined =>
    opponents.find((opp) => String(opp.participant?.id ?? "") === participantId)?.number;
  const team1 = numberOf(team1Participant);
  const team2 = numberOf(team2Participant);
  if (!team1 || !team2) return null;
  const resolved: ResolvedMatch = { toornamentMatchId: target.id, sides: { team1, team2 } };
  resolvedMatches.set(matchKey, resolved);
  return resolved;
}

async function reportToornamentMatch(
  event: TournamentEvent,
  match_id: number | string,
  season_id: number,
  winner: string | null
): Promise<void> {
  const seasonInfo: RowDataPacket[] = await db.query(
    "SELECT id, user_id, toornament_id FROM season WHERE id = ? AND is_toornament = 1",
    [season_id]
  );
  if (!seasonInfo[0]?.toornament_id) return;
  const tournamentId: string = seasonInfo[0].toornament_id;

  const matchInfo: RowDataPacket[] = await db.query(
    "SELECT team1_id, team2_id, max_maps, toornament_match_id, end_time, cancelled FROM `match` WHERE id = ?",
    [match_id]
  );
  if (!matchInfo[0]) return;
  const { team1_id, team2_id } = matchInfo[0];
  const maxMaps: number = Number(matchInfo[0].max_maps) || 1;
  // A late round event must not reopen a match whose result was already sent.
  if (event !== "series_end" && (matchInfo[0].end_time || matchInfo[0].cancelled)) return;

  const teams: RowDataPacket[] = await db.query(
    "SELECT id, toornament_team_id FROM team WHERE id IN (?, ?)",
    [team1_id, team2_id]
  );
  const participantOf = (teamId: number): string | null => {
    const row = teams.find((team) => team.id == teamId);
    return row?.toornament_team_id ? String(row.toornament_team_id) : null;
  };
  const team1Participant: string | null = participantOf(team1_id);
  const team2Participant: string | null = participantOf(team2_id);
  if (!team1Participant || !team2Participant) return;

  const toornament: Toornament = await Toornament.forUser(seasonInfo[0].user_id);
  const matchKey: string = String(match_id);
  const resolved = await resolveMatch(
    toornament,
    tournamentId,
    matchKey,
    matchInfo[0].toornament_match_id ? String(matchInfo[0].toornament_match_id) : null,
    team1Participant,
    team2Participant
  );
  if (!resolved) return;
  const { toornamentMatchId, sides } = resolved;

  const maps: RowDataPacket[] = await db.query(
    "SELECT map_number, map_name, team1_score, team2_score, winner, end_time FROM map_stats WHERE match_id = ? ORDER BY map_number ASC",
    [match_id]
  );
  const planned: string[] = await getPlannedMaps(match_id, maxMaps);
  const resultFor = (winnerTeamId: number | null, teamId: number): ToornamentResult => {
    if (!winnerTeamId) return null;
    return winnerTeamId == teamId ? "win" : "loss";
  };

  let team1Wins: number = 0;
  let team2Wins: number = 0;
  const played: Set<number> = new Set();
  for (const map of maps) {
    played.add(map.map_number);
    if (map.winner == team1_id) team1Wins++;
    else if (map.winner == team2_id) team2Wins++;
    const finished: boolean = map.winner != null || map.end_time != null || event === "series_end";
    const opponents: ToornamentOpponentUpdate[] = [
      { number: sides.team1, score: map.team1_score ?? 0, result: resultFor(map.winner, team1_id) },
      { number: sides.team2, score: map.team2_score ?? 0, result: resultFor(map.winner, team2_id) }
    ];
    const mapName: string | null = map.map_name || planned[map.map_number] || null;
    const status = finished ? "completed" : "running";
    try {
      await sendOnce(
        `${toornamentMatchId}:game:${map.map_number + 1}`,
        { opponents, mapName, status },
        () => toornament.updateGame(toornamentMatchId, map.map_number + 1, opponents, mapName, status)
      );
    } catch (err) {
      // A match configured with fewer games than played maps must not block the match score.
      console.error(`Failed to update Toornament game ${map.map_number + 1}: ${err}`);
    }
  }

  // Games not played yet only get their map, as soon as it is known.
  for (let index = 0; index < planned.length; index++) {
    if (played.has(index) || !planned[index]) continue;
    try {
      await sendOnce(
        `${toornamentMatchId}:game:${index + 1}`,
        { mapName: planned[index] },
        () => toornament.updateGame(toornamentMatchId, index + 1, null, planned[index])
      );
    } catch (err) {
      console.error(`Failed to set the map of Toornament game ${index + 1}: ${err}`);
    }
  }

  if (!maps.length && event !== "series_end") return;

  // A BO1 reports its round score, a series the number of maps won.
  const singleMap: boolean = maxMaps == 1 && maps.length > 0;
  const team1Score: number = singleMap ? maps[0].team1_score ?? 0 : team1Wins;
  const team2Score: number = singleMap ? maps[0].team2_score ?? 0 : team2Wins;
  const team1Update: ToornamentOpponentUpdate = { number: sides.team1, score: team1Score };
  const team2Update: ToornamentOpponentUpdate = { number: sides.team2, score: team2Score };
  if (event === "series_end") {
    if (winner === "team1") {
      team1Update.result = "win";
      team2Update.result = "loss";
    } else if (winner === "team2") {
      team1Update.result = "loss";
      team2Update.result = "win";
    } else {
      team1Update.result = "draw";
      team2Update.result = "draw";
    }
  }
  await sendOnce(`${toornamentMatchId}:match`, [team1Update, team2Update], () =>
    toornament.updateMatch(toornamentMatchId, [team1Update, team2Update])
  );

  if (event !== "series_end") return;
  resolvedMatches.delete(matchKey);
  for (const sentKey of [...sentPayloads.keys()]) {
    if (sentKey.startsWith(`${toornamentMatchId}:`)) sentPayloads.delete(sentKey);
  }
  const remaining: ToornamentMatch[] = await toornament.listMatches(tournamentId, {
    statuses: ["pending", "running"]
  });
  if (remaining.length) return;
  await db.query("UPDATE season SET end_date = ? WHERE id = ?", [
    new Date().toISOString().slice(0, 19).replace("T", " "),
    seasonInfo[0].id
  ]);
  GlobalEmitter.emit("seasonUpdate");
}

/** Imports Toornament participants as teams (names only, no roster).
 *
 * Skips participants already imported for this user, so the import is safe to
 * re-run against a tournament that has since gained participants.
 * @param {number} userId - The internal user ID that will own the teams.
 * @param {ToornamentParticipant[]} participants - Participants to import.
 */
export async function importToornamentTeams(
  userId: number,
  participants: ToornamentParticipant[]
): Promise<number> {
  if (!participants.length) return 0;
  const ids: string[] = participants.map((participant) => String(participant.id));
  const existing: RowDataPacket[] = await db.query(
    "SELECT toornament_team_id FROM team WHERE user_id = ? AND toornament_team_id IN (?)",
    [userId, ids]
  );
  const alreadyImported: Set<string> = new Set(
    existing.map((row) => String(row.toornament_team_id))
  );
  const newParticipants: ToornamentParticipant[] = participants.filter(
    (participant) => !alreadyImported.has(String(participant.id))
  );
  if (!newParticipants.length) return 0;

  await db.query("INSERT INTO team (user_id, name, tag, toornament_team_id) VALUES ?", [
    newParticipants.map((participant) => [
      userId,
      participant.name.substring(0, 40),
      participant.name.substring(0, 40),
      String(participant.id)
    ])
  ]);
  return newParticipants.length;
}
