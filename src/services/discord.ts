/**
 * Discord integration of seasons, through up to three webhooks per season:
 *
 * - launch: a match is posted when it is created, edited when its server
 *   changes, and deleted as soon as it is launched (veto, map loaded, score).
 * - live: a match is posted when it is launched, edited on every veto step
 *   and score update, and deleted when it ends, is cancelled, forfeited or deleted.
 * - results: the final score of a finished match is posted once.
 *
 * Every exported function swallows its errors: Discord must never break the
 * match flow.
 *
 * @module services/discord
 */

import fetch, { Response } from "node-fetch";
import config from "config";
import { RowDataPacket } from "mysql2";

import { db } from "./db.js";
import Utils from "../utility/utils.js";

const WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/i;
/** Name displayed as the author of every message, overriding the webhook's own name. */
const BOT_NAME = "eBot";
const COLORS = { launch: 0x2196f3, live: 0xe53935, results: 0x43a047, draw: 0x9e9e9e };

export type DiscordChannel = "launch" | "live" | "results";

/** Season column holding the encrypted webhook URL of each channel. */
export const CHANNEL_COLUMNS: Record<DiscordChannel, string> = {
  launch: "discord_webhook_url",
  live: "discord_live_webhook_url",
  results: "discord_results_webhook_url"
};
export const CHANNELS: DiscordChannel[] = ["launch", "live", "results"];

const TEST_MESSAGES: Record<DiscordChannel, string> = {
  launch: "Matches to launch will be posted here, with the connect command of their server.",
  live: "Live matches will be posted here and updated with every score change.",
  results: "Final scores of finished matches will be posted here."
};

/** Thrown for invalid webhook URLs or failed Discord calls. Never carries the token. */
export class DiscordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DiscordError";
  }
}

export function isDiscordChannel(value: unknown): value is DiscordChannel {
  return CHANNELS.includes(value as DiscordChannel);
}

/** Normalizes a webhook URL, or throws if it is not a Discord webhook. */
export function normalizeWebhookUrl(raw: string): string {
  const match = String(raw ?? "").trim().match(WEBHOOK_PATTERN);
  if (!match) {
    throw new DiscordError(
      400,
      "Invalid Discord webhook URL. Expected https://discord.com/api/webhooks/<id>/<token>."
    );
  }
  return `https://discord.com/api/webhooks/${match[1]}/${match[2]}`;
}

/** Calls the webhook API. The path is appended to the webhook URL. */
async function callWebhook(
  webhookUrl: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string = "",
  body?: object
): Promise<any> {
  const response: Response = await fetch(`${webhookUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 204) return null;
  const text: string = await response.text().catch(() => "");
  if (!response.ok) {
    // Discord echoes nothing secret in its errors, but keep them short.
    throw new DiscordError(response.status, `Discord returned ${response.status}: ${text.substring(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Deletes a message, ignoring messages already deleted by hand. */
async function deleteMessage(webhookUrl: string, messageId: string): Promise<void> {
  await callWebhook(webhookUrl, "DELETE", `/messages/${messageId}`).catch((err) => {
    if (!(err instanceof DiscordError && err.status === 404)) throw err;
  });
}

/** Returns the decrypted webhook URL of a season channel, if one is configured. */
async function getSeasonWebhook(
  seasonId: number | null | undefined,
  channel: DiscordChannel
): Promise<string | null> {
  if (!seasonId) return null;
  const rows: RowDataPacket[] = await db.query(
    `SELECT ${CHANNEL_COLUMNS[channel]} AS url FROM season WHERE id = ?`,
    [seasonId]
  );
  const encrypted = rows[0]?.url;
  return encrypted ? Utils.decrypt(encrypted) || null : null;
}

/** Checks a webhook exists and returns the channel and webhook names. */
export async function describeWebhook(
  webhookUrl: string
): Promise<{ name: string; channel_id: string; guild_id: string | null }> {
  try {
    const info = await callWebhook(webhookUrl, "GET");
    return { name: info.name, channel_id: info.channel_id, guild_id: info.guild_id ?? null };
  } catch (err) {
    if (err instanceof DiscordError && (err.status === 401 || err.status === 404)) {
      throw new DiscordError(400, "This Discord webhook does not exist or was deleted.");
    }
    throw err;
  }
}

/* Per-match queue: score events arrive every round and may overlap, so every
 * Discord update of a match runs one after the other. */
const queues: Map<string, Promise<void>> = new Map();
const pendingLive: Set<string> = new Set();

function enqueue(matchId: number | string, task: () => Promise<void>): Promise<void> {
  const key: string = String(matchId);
  const next: Promise<void> = (queues.get(key) ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error(`Discord update of match ${key} failed: ${err}`));
  queues.set(key, next);
  next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

/* Message builders */

interface MatchRow extends RowDataPacket {
  id: number;
  title: string | null;
  max_maps: number | null;
  skip_veto: number | null;
  veto_mappool: string | null;
  team1_id: number;
  team2_id: number;
  team1_string: string | null;
  team2_string: string | null;
  team1_score: number | null;
  team2_score: number | null;
  winner: number | null;
  cancelled: number | null;
  forfeit: number | null;
  end_time: Date | null;
  season_id: number | null;
  season_name: string | null;
  ip_string: string | null;
  port: number | null;
  discord_message_id: string | null;
  discord_live_message_id: string | null;
  discord_result_message_id: string | null;
}

async function loadMatch(matchId: number | string): Promise<MatchRow | null> {
  const rows = (await db.query(
    "SELECT m.id, m.title, m.max_maps, m.skip_veto, m.veto_mappool, m.team1_id, m.team2_id, " +
      "m.team1_string, m.team2_string, m.team1_score, m.team2_score, m.winner, m.cancelled, m.forfeit, " +
      "m.end_time, m.season_id, m.discord_message_id, m.discord_live_message_id, m.discord_result_message_id, " +
      "s.name AS season_name, g.ip_string, g.port " +
      "FROM `match` m LEFT JOIN season s ON s.id = m.season_id " +
      "LEFT JOIN game_server g ON g.id = m.server_id WHERE m.id = ?",
    [matchId]
  )) as MatchRow[];
  return rows[0] ?? null;
}

async function loadMaps(matchId: number | string): Promise<RowDataPacket[]> {
  return db.query(
    "SELECT map_number, map_name, team1_score, team2_score, winner, end_time FROM map_stats " +
      "WHERE match_id = ? ORDER BY map_number ASC",
    [matchId]
  );
}

async function loadVetoes(matchId: number | string): Promise<RowDataPacket[]> {
  return db.query(
    "SELECT team_name, map, pick_or_veto FROM veto WHERE match_id = ? ORDER BY id ASC",
    [matchId]
  );
}

/** Returns the match title to display, or undefined if it is only a get5 template.
 *
 * Matches created without a title get the get5 default "Map {MAPNUMBER} of {MAXMAPS}",
 * whose placeholders are filled in game per map and mean nothing outside the game.
 */
function displayTitle(title: string | null | undefined): string | undefined {
  const value: string = String(title ?? "").trim();
  if (!value || /\{[A-Z0-9_]+\}/.test(value)) return undefined;
  return value;
}

function teamNames(match: MatchRow): { team1: string; team2: string } {
  return { team1: match.team1_string || "Team 1", team2: match.team2_string || "Team 2" };
}

/** Common embed parts: link to the match page and season footer. */
function baseEmbed(match: MatchRow, color: number): Record<string, any> {
  const clientHome: string = config.has("server.clientHome")
    ? String(config.get("server.clientHome")).replace(/\/$/, "")
    : "";
  const embed: Record<string, any> = {
    color,
    footer: {
      text: match.season_name ? `${match.season_name} · Match #${match.id}` : `Match #${match.id}`
    },
    timestamp: new Date().toISOString()
  };
  if (/^https?:\/\//.test(clientHome)) embed.url = `${clientHome}/match/${match.id}`;
  return embed;
}

function wrap(embed: Record<string, any>): object {
  return { username: BOT_NAME, embeds: [embed], allowed_mentions: { parse: [] } };
}

/** One line per map, e.g. "✅ de_nuke — **13 - 7**". */
function mapLines(match: MatchRow, maps: RowDataPacket[], finished: boolean): string {
  return maps
    .map((map) => {
      const name: string = map.map_name || `Map ${map.map_number + 1}`;
      const done: boolean = finished || Boolean(map.end_time) || map.winner != null;
      const icon: string = done ? "✅" : "▶️";
      return `${icon} ${name} — **${map.team1_score ?? 0} - ${map.team2_score ?? 0}**`;
    })
    .join("\n");
}

function buildLaunchMessage(match: MatchRow): object {
  const { team1, team2 } = teamNames(match);
  const fields: object[] = [{ name: "Format", value: `BO${match.max_maps ?? 1}`, inline: true }];
  if (match.skip_veto && match.veto_mappool) {
    const maps: string[] = String(match.veto_mappool).split(" ").filter(Boolean);
    fields.push({ name: "Maps", value: maps.slice(0, match.max_maps || 1).join(", "), inline: true });
  } else {
    fields.push({ name: "Veto", value: "In game", inline: true });
  }
  fields.push({
    name: "Server",
    value: match.ip_string ? `\`\`\`connect ${match.ip_string}:${match.port}\`\`\`` : "Not assigned yet",
    inline: false
  });
  return wrap({
    ...baseEmbed(match, COLORS.launch),
    title: `${team1} vs ${team2}`,
    description: displayTitle(match.title),
    fields
  });
}

function buildLiveMessage(match: MatchRow, maps: RowDataPacket[], vetoes: RowDataPacket[] = []): object {
  const { team1, team2 } = teamNames(match);
  const lines: string[] = [];
  const title: string | undefined = displayTitle(match.title);
  if (title) lines.push(title);
  if ((match.max_maps ?? 1) > 1) {
    lines.push(`Series: **${match.team1_score ?? 0} - ${match.team2_score ?? 0}** (BO${match.max_maps})`);
  }
  const maplist: string = mapLines(match, maps, false);
  if (maplist) lines.push(maplist);
  else if (vetoes.length) {
    lines.push("**Veto in progress**");
    lines.push(
      vetoes
        .map((v) =>
          v.team_name === "Decider"
            ? `🎯 Decider: ${v.map}`
            : v.pick_or_veto === "pick"
            ? `✅ ${v.team_name} picks ${v.map}`
            : `❌ ${v.team_name} bans ${v.map}`
        )
        .join("\n")
    );
  } else lines.push("Warmup / veto in progress");
  const fields: object[] = [];
  if (match.ip_string) {
    fields.push({ name: "Server", value: `\`\`\`connect ${match.ip_string}:${match.port}\`\`\``, inline: false });
  }
  return wrap({
    ...baseEmbed(match, COLORS.live),
    author: { name: "🔴 LIVE" },
    title: `${team1} vs ${team2}`,
    description: lines.join("\n"),
    fields
  });
}

function buildResultMessage(match: MatchRow, maps: RowDataPacket[]): object {
  const { team1, team2 } = teamNames(match);
  // A BO1 is best summed up by its round score, a series by the maps won.
  const singleMap: boolean = (match.max_maps ?? 1) == 1 && maps.length === 1;
  const score1: number = (singleMap ? maps[0].team1_score : match.team1_score) ?? 0;
  const score2: number = (singleMap ? maps[0].team2_score : match.team2_score) ?? 0;
  let headline: string;
  let color: number = COLORS.results;
  if (match.winner != null && match.winner == match.team1_id) {
    headline = `🏆 **${team1}** wins${match.forfeit ? " by forfeit" : ""}`;
  } else if (match.winner != null && match.winner == match.team2_id) {
    headline = `🏆 **${team2}** wins${match.forfeit ? " by forfeit" : ""}`;
  } else {
    headline = "🤝 Draw";
    color = COLORS.draw;
  }
  const lines: string[] = [headline];
  const title: string | undefined = displayTitle(match.title);
  if (title) lines.push(title);
  if (!singleMap) {
    const maplist: string = mapLines(match, maps, true);
    if (maplist) lines.push(maplist);
  } else if (maps[0]?.map_name) {
    lines.push(`Map: ${maps[0].map_name}`);
  }
  return wrap({
    ...baseEmbed(match, color),
    title: `${team1}  ${score1} - ${score2}  ${team2}`,
    description: lines.join("\n")
  });
}

function isFinished(match: MatchRow): boolean {
  return match.cancelled == 1 || match.end_time != null;
}

/* Launch channel */

/** Posts the announcement of a newly created match to its season channel. Never throws. */
export function announceMatch(matchId: number): Promise<void> {
  return enqueue(matchId, async () => {
    const match = await loadMatch(matchId);
    if (!match || match.discord_message_id || isFinished(match)) return;
    const webhookUrl = await getSeasonWebhook(match.season_id, "launch");
    if (!webhookUrl) return;
    const posted = await callWebhook(webhookUrl, "POST", "?wait=true", buildLaunchMessage(match));
    if (posted?.id) {
      await db.query("UPDATE `match` SET discord_message_id = ? WHERE id = ?", [posted.id, matchId]);
    }
  });
}

/** Refreshes the announcement of a match (e.g. after a server change). Never throws. */
export function refreshMatchAnnouncement(matchId: number): Promise<void> {
  return enqueue(matchId, async () => {
    const match = await loadMatch(matchId);
    if (!match?.discord_message_id) return;
    const webhookUrl = await getSeasonWebhook(match.season_id, "launch");
    if (!webhookUrl) return;
    await callWebhook(webhookUrl, "PATCH", `/messages/${match.discord_message_id}`, buildLaunchMessage(match));
  });
}

async function removeLaunchMessage(match: MatchRow): Promise<void> {
  if (!match.discord_message_id) return;
  await db.query("UPDATE `match` SET discord_message_id = NULL WHERE id = ?", [match.id]);
  const webhookUrl = await getSeasonWebhook(match.season_id, "launch");
  if (webhookUrl) await deleteMessage(webhookUrl, match.discord_message_id);
}

async function removeLiveMessage(match: MatchRow): Promise<void> {
  if (!match.discord_live_message_id) return;
  await db.query("UPDATE `match` SET discord_live_message_id = NULL WHERE id = ?", [match.id]);
  const webhookUrl = await getSeasonWebhook(match.season_id, "live");
  if (webhookUrl) await deleteMessage(webhookUrl, match.discord_live_message_id);
}

/** Removes the "to launch" announcement of a match, if it still exists. Idempotent, never throws. */
export function removeMatchAnnouncement(matchId: number | string): Promise<void> {
  return enqueue(matchId, async () => {
    const match = await loadMatch(matchId);
    if (match) await removeLaunchMessage(match);
  });
}

/* Live channel */

/** Posts or updates the live state of a match, and drops it from the launch
 * channel: anything live (veto, warmup, map change, score) means the match
 * was launched. Several calls in a row are coalesced. Never throws. */
export function updateLiveMatch(matchId: number | string): Promise<void> {
  const key: string = String(matchId);
  if (pendingLive.has(key)) return queues.get(key) ?? Promise.resolve();
  pendingLive.add(key);
  return enqueue(matchId, async () => {
    pendingLive.delete(key);
    const match = await loadMatch(matchId);
    // A late round event must not bring back a match that already ended.
    if (!match || isFinished(match)) return;
    await removeLaunchMessage(match);
    const webhookUrl = await getSeasonWebhook(match.season_id, "live");
    if (!webhookUrl) return;
    const message = buildLiveMessage(match, await loadMaps(matchId), await loadVetoes(matchId));
    if (match.discord_live_message_id) {
      try {
        await callWebhook(webhookUrl, "PATCH", `/messages/${match.discord_live_message_id}`, message);
        return;
      } catch (err) {
        // Deleted by hand in Discord: post it again below.
        if (!(err instanceof DiscordError && err.status === 404)) throw err;
      }
    }
    const posted = await callWebhook(webhookUrl, "POST", "?wait=true", message);
    if (posted?.id) {
      await db.query("UPDATE `match` SET discord_live_message_id = ? WHERE id = ?", [posted.id, matchId]);
    }
  });
}

/** A match goes live (veto started, map loaded, first score): moves it from
 * the launch channel to the live channel. Never throws. */
export function matchWentLive(matchId: number | string): Promise<void> {
  return updateLiveMatch(matchId);
}

/* End of match */

/** A match ended (finished, forfeited or cancelled): clears its launch and live
 * messages, and posts its final score in the results channel unless it was
 * cancelled. Idempotent, never throws. */
export function finishMatch(matchId: number | string): Promise<void> {
  return enqueue(matchId, async () => {
    const match = await loadMatch(matchId);
    if (!match) return;
    await removeLaunchMessage(match);
    await removeLiveMessage(match);
    if (match.cancelled == 1 || match.discord_result_message_id) return;
    const webhookUrl = await getSeasonWebhook(match.season_id, "results");
    if (!webhookUrl) return;
    const posted = await callWebhook(
      webhookUrl,
      "POST",
      "?wait=true",
      buildResultMessage(match, await loadMaps(matchId))
    );
    if (posted?.id) {
      await db.query("UPDATE `match` SET discord_result_message_id = ? WHERE id = ?", [posted.id, matchId]);
    }
  });
}

/** Clears the launch and live messages of a match without posting a result (e.g. before deleting it). Never throws. */
export function clearMatchMessages(matchId: number | string): Promise<void> {
  return enqueue(matchId, async () => {
    const match = await loadMatch(matchId);
    if (!match) return;
    await removeLaunchMessage(match);
    await removeLiveMessage(match);
  });
}

/* Settings */

/** Posts then deletes a short message, to check a webhook end to end. */
export async function sendTestMessage(
  webhookUrl: string,
  seasonName: string,
  channel: DiscordChannel = "launch"
): Promise<void> {
  const posted = await callWebhook(webhookUrl, "POST", "?wait=true", {
    username: BOT_NAME,
    content: `✅ ${BOT_NAME} is connected to this channel for the season **${seasonName}**. ${TEST_MESSAGES[channel]}`,
    allowed_mentions: { parse: [] }
  });
  if (posted?.id) {
    setTimeout(() => {
      callWebhook(webhookUrl, "DELETE", `/messages/${posted.id}`).catch(() => undefined);
    }, 30 * 1000);
  }
}
