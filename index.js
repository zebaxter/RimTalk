import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NBA_API_KEY = process.env.NBA_API_KEY;

const CHANNEL_SCORES_ID = process.env.CHANNEL_SCORES_ID;
const CHANNEL_INJURY_ID = process.env.CHANNEL_INJURY_ID;
const CHANNEL_TRADE_ID  = process.env.CHANNEL_TRADE_ID;
const CHANNEL_DRAFT_ID  = process.env.CHANNEL_DRAFT_ID;

if (!DISCORD_TOKEN) throw new Error("❌ DISCORD_TOKEN manquant dans .env");
if (!NBA_API_KEY) throw new Error("❌ NBA_API_KEY manquant dans .env");
if (!CHANNEL_SCORES_ID) throw new Error("❌ CHANNEL_SCORES_ID manquant dans .env");

// ---- Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ---- Persisted state (anti-spam même après restart)
const STATE_FILE = "./state.json";
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return { posted: {}, lastScheduleDatePosted: null }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const state = loadState();

// Util: publish only if changed
function shouldPost(key, signature) {
  const prev = state.posted[key];
  if (prev === signature) return false;
  state.posted[key] = signature;
  saveState(state);
  return true;
}

// ---- Time helpers
function parisDateYYYYMMDD() {
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

// ---- BallDontLie: games by date
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
  if (state.lastScheduleDatePosted === date) return;

  const games = await fetchGamesByDate(date);
  state.lastScheduleDatePosted = date;
  saveState(state);

  if (!games.length) {
    await channel.send(`📅 **Programme NBA du ${date}**\nAucun match prévu aujourd’hui.`);
    return;
  }

  // Init anti-spam des updates de score
  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;
    state.posted[`score_${gameId}`] = signature;
  }
  saveState(state);

  const lines = games.map(formatGameLine).join("\n");
  await channel.send(`📅 **Programme NBA du ${date}**\n${lines}`);
}

async function pollAndPostScoreUpdates(channel) {
  const date = parisDateYYYYMMDD();
  const games = await fetchGamesByDate(date);
  if (!games.length) return;

  const updates = [];
  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;
    if (shouldPost(`score_${gameId}`, signature)) {
      // Au 1er passage après restart, ça risque de poster tout : on évite si pas encore "live/final"
      // Si tu veux poster tout de suite au restart, supprime cette condition.
      const st = (g.status ?? "").toLowerCase();
      const isInteresting = st.includes("final") || st.includes("q") || st.includes("half") || st.includes("ot");
      if (isInteresting) updates.push(formatGameLine(g));
    }
  }

  if (updates.length) {
    await channel.send(`🏀 **Update scores**\n${updates.join("\n")}`);
  }
}

// ---- BallDontLie: injuries
// Doc: GET https://api.balldontlie.io/v1/player_injuries :contentReference[oaicite:2]{index=2}
async function fetchInjuriesPage(cursor = null) {
  const base = "https://api.balldontlie.io/v1/player_injuries?per_page=100";
  const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;

  const res = await fetch(url, { headers: { Authorization: NBA_API_KEY } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Injuries API error ${res.status} ${txt}`);
  }
  return await res.json();
}

function formatInjury(i) {
  const player = i.player?.first_name && i.player?.last_name
    ? `${i.player.first_name} ${i.player.last_name}`
    : (i.player?.name ?? "Unknown player");

  const team = i.team?.abbreviation ?? "";
  const status = i.status ?? "Unknown";
  const desc = i.description ?? "";
  return `• **${player}** (${team}) — ${status}${desc ? ` · ${desc}` : ""}`;
}

async function pollAndPostInjuries(channel) {
  // On prend juste la 1ère page (100). Si tu veux tout, boucle sur cursor.
  const json = await fetchInjuriesPage(null);
  const injuries = json.data ?? [];
  if (!injuries.length) return;

  // On poste seulement les nouveautés (clé basée sur id + updated_at si dispo)
  const lines = [];
  for (const i of injuries.slice(0, 20)) { // limite anti-spam
    const id = String(i.id ?? `${i.player?.id}-${i.team?.id}-${i.status}`);
    const sig = `${i.status}|${i.description ?? ""}|${i.updated_at ?? ""}`;
    if (shouldPost(`injury_${id}`, sig)) {
      lines.push(formatInjury(i));
    }
  }

  if (lines.length) {
    await channel.send(`🩺 **Injury update**\n${lines.join("\n")}`);
  }
}

// ---- ESPN news (trade/draft)
// Simple: on filtre par mots-clés dans le titre
async function fetchEspnNbaNews() {
  const url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news";
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ESPN news error ${res.status} ${txt}`);
  }
  return await res.json();
}

function pickArticleFields(a) {
  const id = String(a.id || a.dataSourceIdentifier || "");
  const title = a.headline || a.title || "NBA News";
  const link = a.links?.web?.href || a.link || a.url || "";
  return { id: id || `${title}|${link}`, title, link };
}

async function pollAndPostNews(tradeChannel, draftChannel) {
  const data = await fetchEspnNbaNews();
  const articles = data.articles || data.headlines || [];
  if (!articles.length) return;

  for (const a of articles.slice(0, 30)) {
    const { id, title, link } = pickArticleFields(a);
    const t = title.toLowerCase();

    const isTrade = /trade|traded|waive|waived|sign|signed|deal|transaction/.test(t);
    const isDraft = /draft|mock|lottery|prospect|combine/.test(t);

    if (isTrade && tradeChannel) {
      if (shouldPost(`news_trade_${id}`, title)) {
        await tradeChannel.send(`🔁 **TRADE / TRANSACTION**\n**${title}**\n${link}`);
      }
    } else if (isDraft && draftChannel) {
      if (shouldPost(`news_draft_${id}`, title)) {
        await draftChannel.send(`🧢 **DRAFT**\n**${title}**\n${link}`);
      }
    }
  }
}

// ---- Boot
client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  const scoresChannel = await client.channels.fetch(CHANNEL_SCORES_ID);
  if (!scoresChannel?.isTextBased()) throw new Error("❌ CHANNEL_SCORES_ID n'est pas un salon texte");

  const injuryChannel = CHANNEL_INJURY_ID ? await client.channels.fetch(CHANNEL_INJURY_ID) : null;
  const tradeChannel  = CHANNEL_TRADE_ID  ? await client.channels.fetch(CHANNEL_TRADE_ID)  : null;
  const draftChannel  = CHANNEL_DRAFT_ID  ? await client.channels.fetch(CHANNEL_DRAFT_ID)  : null;

  if (injuryChannel && !injuryChannel.isTextBased()) throw new Error("❌ CHANNEL_INJURY_ID n'est pas un salon texte");
  if (tradeChannel && !tradeChannel.isTextBased())   throw new Error("❌ CHANNEL_TRADE_ID n'est pas un salon texte");
  if (draftChannel && !draftChannel.isTextBased())   throw new Error("❌ CHANNEL_DRAFT_ID n'est pas un salon texte");

  // 1) Au démarrage : schedule du jour
  await postDailyScheduleIfNeeded(scoresChannel).catch(console.error);

  // 2) Scores toutes les 5 minutes
  setInterval(() => {
    pollAndPostScoreUpdates(scoresChannel).catch(console.error);
  }, 5 * 60 * 1000);

  // 3) Schedule à 09:00 (Paris)
  setInterval(() => {
    const { hh, mi } = parisHourMinute();
    if (hh === 9 && mi === 0) {
      postDailyScheduleIfNeeded(scoresChannel).catch(console.error);
    }
  }, 60 * 1000);

  // 4) Injuries toutes les 15 minutes
  if (injuryChannel) {
    setInterval(() => {
      pollAndPostInjuries(injuryChannel).catch(console.error);
    }, 15 * 60 * 1000);
  }

  // 5) Trade / Draft news toutes les 10 minutes
  if (tradeChannel || draftChannel) {
    setInterval(() => {
      pollAndPostNews(tradeChannel, draftChannel).catch(console.error);
    }, 10 * 60 * 1000);
  }
});

client.login(DISCORD_TOKEN);
