/**
 * Announces the matches of a season in a Discord channel through a webhook.
 *
 * A message is posted when a match is created, edited when its server
 * changes, and deleted as soon as the match goes live (first score), or when
 * it is cancelled, forfeited or deleted. Every function here swallows its
 * errors: Discord must never break the match flow.
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
const EMBED_COLOR = 0x2196f3;
/** Name displayed as the author of every message, overriding the webhook's own name. */
const BOT_NAME = "eBot";

/** Thrown for invalid webhook URLs or failed Discord calls. Never carries the token. */
export class DiscordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DiscordError";
  }
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

/** Returns the decrypted webhook URL of a season, if one is configured. */
async function getSeasonWebhook(seasonId: number | null | undefined): Promise<string | null> {
  if (!seasonId) return null;
  const rows: RowDataPacket[] = await db.query(
    "SELECT discord_webhook_url FROM season WHERE id = ?",
    [seasonId]
  );
  const encrypted = rows[0]?.discord_webhook_url;
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

/** Returns the match title to display, or undefined if it is only a get5 template.
 *
 * Matches created without a title get the get5 default "Map {MAPNUMBER} of {MAXMAPS}",
 * whose placeholders are filled in game per map and mean nothing before the match.
 */
function displayTitle(title: string | null | undefined): string | undefined {
  const value: string = String(title ?? "").trim();
  if (!value || /\{[A-Z0-9_]+\}/.test(value)) return undefined;
  return value;
}

/** Builds the announcement of a match. */
async function buildMessage(matchId: number): Promise<object | null> {
  const rows: RowDataPacket[] = await db.query(
    "SELECT m.id, m.title, m.max_maps, m.skip_veto, m.veto_mappool, m.team1_string, m.team2_string, " +
      "s.name AS season_name, g.ip_string, g.port " +
      "FROM `match` m LEFT JOIN season s ON s.id = m.season_id " +
      "LEFT JOIN game_server g ON g.id = m.server_id WHERE m.id = ?",
    [matchId]
  );
  const match = rows[0];
  if (!match) return null;

  const team1: string = match.team1_string || "Team 1";
  const team2: string = match.team2_string || "Team 2";
  const fields: object[] = [
    { name: "Format", value: `BO${match.max_maps ?? 1}`, inline: true }
  ];
  if (match.skip_veto && match.veto_mappool) {
    const maps: string[] = String(match.veto_mappool).split(" ").filter(Boolean);
    fields.push({ name: "Maps", value: maps.slice(0, match.max_maps || 1).join(", "), inline: true });
  } else {
    fields.push({ name: "Veto", value: "In game", inline: true });
  }
  fields.push({
    name: "Server",
    value: match.ip_string
      ? `\`\`\`connect ${match.ip_string}:${match.port}\`\`\``
      : "Not assigned yet",
    inline: false
  });

  const clientHome: string = config.has("server.clientHome")
    ? String(config.get("server.clientHome")).replace(/\/$/, "")
    : "";
  const embed: Record<string, any> = {
    title: `${team1} vs ${team2}`,
    description: displayTitle(match.title),
    color: EMBED_COLOR,
    fields,
    footer: { text: match.season_name ? `${match.season_name} · Match #${match.id}` : `Match #${match.id}` },
    timestamp: new Date().toISOString()
  };
  if (/^https?:\/\//.test(clientHome)) embed.url = `${clientHome}/match/${match.id}`;
  return {
    username: BOT_NAME,
    embeds: [embed],
    allowed_mentions: { parse: [] }
  };
}

/** Posts the announcement of a newly created match to its season channel. Never throws. */
export async function announceMatch(matchId: number): Promise<void> {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT season_id, discord_message_id FROM `match` WHERE id = ?",
      [matchId]
    );
    if (!rows[0] || rows[0].discord_message_id) return;
    const webhookUrl = await getSeasonWebhook(rows[0].season_id);
    if (!webhookUrl) return;
    const message = await buildMessage(matchId);
    if (!message) return;
    const posted = await callWebhook(webhookUrl, "POST", "?wait=true", message);
    if (posted?.id) {
      await db.query("UPDATE `match` SET discord_message_id = ? WHERE id = ?", [posted.id, matchId]);
    }
  } catch (err) {
    console.error(`Failed to announce match ${matchId} on Discord: ${err}`);
  }
}

/** Refreshes the announcement of a match (e.g. after a server change). Never throws. */
export async function refreshMatchAnnouncement(matchId: number): Promise<void> {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT season_id, discord_message_id FROM `match` WHERE id = ?",
      [matchId]
    );
    if (!rows[0]?.discord_message_id) return;
    const webhookUrl = await getSeasonWebhook(rows[0].season_id);
    if (!webhookUrl) return;
    const message = await buildMessage(matchId);
    if (!message) return;
    await callWebhook(webhookUrl, "PATCH", `/messages/${rows[0].discord_message_id}`, message);
  } catch (err) {
    console.error(`Failed to update the Discord announcement of match ${matchId}: ${err}`);
  }
}

/** Removes the announcement of a match, if it still exists. Idempotent, never throws. */
export async function removeMatchAnnouncement(matchId: number | string): Promise<void> {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT season_id, discord_message_id FROM `match` WHERE id = ?",
      [matchId]
    );
    const messageId: string | null = rows[0]?.discord_message_id ?? null;
    if (!messageId) return;
    // Claim the message first so concurrent events (every round end) delete it once.
    const claim: any = await db.query(
      "UPDATE `match` SET discord_message_id = NULL WHERE id = ? AND discord_message_id = ?",
      [matchId, messageId]
    );
    if (!claim?.affectedRows) return;
    const webhookUrl = await getSeasonWebhook(rows[0].season_id);
    if (!webhookUrl) return;
    await callWebhook(webhookUrl, "DELETE", `/messages/${messageId}`).catch((err) => {
      // Already deleted by hand in Discord: nothing to do.
      if (!(err instanceof DiscordError && err.status === 404)) throw err;
    });
  } catch (err) {
    console.error(`Failed to remove the Discord announcement of match ${matchId}: ${err}`);
  }
}

/** Posts then deletes a short message, to check a webhook end to end. */
export async function sendTestMessage(webhookUrl: string, seasonName: string): Promise<void> {
  const posted = await callWebhook(webhookUrl, "POST", "?wait=true", {
    username: BOT_NAME,
    content: `✅ ${BOT_NAME} is connected to this channel for the season **${seasonName}**. Matches to launch will be posted here.`,
    allowed_mentions: { parse: [] }
  });
  if (posted?.id) {
    setTimeout(() => {
      callWebhook(webhookUrl, "DELETE", `/messages/${posted.id}`).catch(() => undefined);
    }, 30 * 1000);
  }
}
