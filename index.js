import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NBA_API_KEY = process.env.NBA_API_KEY;
const CHANNEL_SCORES_ID = process.env.CHANNEL_SCORES_ID;

if (!DISCORD_TOKEN) throw new Error("❌ DISCORD_TOKEN manquant dans .env");
if (!NBA_API_KEY) throw new Error("❌ NBA_API_KEY manquant dans .env");
if (!CHANNEL_SCORES_ID) throw new Error("❌ CHANNEL_SCORES_ID manquant dans .env");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Memo état des matchs (pour publier seulement quand ça change)
const lastState = new Map(); // gameId -> signature
let lastScheduleDatePosted = null; // "YYYY-MM-DD"

function parisDateYYYYMMDD() {
  // Date "locale Paris" sans lib externe
  const now = new Date();
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const yyyy = parts.find(p => p.type === "year").value;
  const mm = parts.find(p => p.type === "month").value;
  const dd = parts.find(p => p.type === "day").value;
  return `${yyyy}-${mm}-${dd}`;
}

function parisHourMinute() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hh = parts.find(p => p.type === "hour").value;
  const mi = parts.find(p => p.type === "minute").value;
  return { hh: Number(hh), mi: Number(mi) };
}

async function fetchGamesByDate(dateYYYYMMDD) {
  const url = `https://api.balldontlie.io/v1/games?dates[]=${dateYYYYMMDD}&per_page=100`;
  const res = await fetch(url, { headers: { Authorization: NBA_API_KEY } });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API error ${res.status} ${txt}`);
  }

  const json = await res.json();
  return json.data ?? [];
}

function formatGameLine(g) {
  const home = g.home_team?.abbreviation ?? "HOME";
  const away = g.visitor_team?.abbreviation ?? "AWAY";
  const hs = g.home_team_score ?? 0;
  const as = g.visitor_team_score ?? 0;
  const status = g.status ?? "TBD";
  return `• **${away} ${as} - ${hs} ${home}** · ${status}`;
}

async function postDailyScheduleIfNeeded(channel) {
  const date = parisDateYYYYMMDD();
  if (lastScheduleDatePosted === date) return;

  const games = await fetchGamesByDate(date);

  lastScheduleDatePosted = date;

  if (!games.length) {
    await channel.send(`📅 **Programme NBA du ${date}**\nAucun match prévu aujourd’hui.`);
    console.log("📅 Schedule posted: no games");
    return;
  }

  // Au passage on initialise lastState pour éviter de spammer "updates" sur le 1er scan
  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;
    if (!lastState.has(gameId)) lastState.set(gameId, signature);
  }

  const lines = games.map(formatGameLine).join("\n");
  await channel.send(`📅 **Programme NBA du ${date}**\n${lines}`);
  console.log(`📅 Schedule posted: ${games.length} games`);
}

async function pollAndPostScoreUpdates(channel) {
  const date = parisDateYYYYMMDD();
  const games = await fetchGamesByDate(date);

  if (!games.length) {
    console.log("ℹ️ No games today (or not available yet).");
    return;
  }

  const updates = [];

  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;

    // 1ère fois : on mémorise sans poster
    if (!lastState.has(gameId)) {
      lastState.set(gameId, signature);
      continue;
    }

    if (lastState.get(gameId) !== signature) {
      lastState.set(gameId, signature);
      updates.push(formatGameLine(g));
    }
  }

  if (updates.length) {
    await channel.send(`🏀 **Update scores**\n${updates.join("\n")}`);
    console.log(`✅ Posted ${updates.length} updates`);
  } else {
    console.log("ℹ️ No new updates");
  }
}

client.once("clientReady", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_SCORES_ID);
  if (!channel?.isTextBased()) throw new Error("❌ CHANNEL_SCORES_ID n'est pas un salon texte");

  // 1) Au démarrage : poste le programme du jour (une seule fois / jour)
  await postDailyScheduleIfNeeded(channel).catch(console.error);

  // 2) Ensuite : toutes les 5 minutes, check updates
  setInterval(() => {
    pollAndPostScoreUpdates(channel).catch(console.error);
  }, 5 * 60 * 1000);

  // 3) Et une fois par minute, si on est autour de 09:00 (Paris), on poste le programme du jour
  // (ça évite les libs de cron)
  setInterval(() => {
    const { hh, mi } = parisHourMinute();
    if (hh === 9 && mi === 0) {
      postDailyScheduleIfNeeded(channel).catch(console.error);
    }
  }, 60 * 1000);
});

client.login(DISCORD_TOKEN);
