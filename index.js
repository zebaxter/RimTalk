import "dotenv/config";
import { Client, GatewayIntentBits, Events, EmbedBuilder } from "discord.js";
import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NBA_API_KEY = process.env.NBA_API_KEY;

const CHANNEL_MATCH_DU_JOUR = process.env.CHANNEL_MATCH_DU_JOUR; // ✅ programme (schedule)
const CHANNEL_SCORES_ID = process.env.CHANNEL_SCORES_ID;         // ✅ scores live / updates

const CHANNEL_INJURY_ID = process.env.CHANNEL_INJURY_ID;
const CHANNEL_TRADE_ID  = process.env.CHANNEL_TRADE_ID;
const CHANNEL_DRAFT_ID  = process.env.CHANNEL_DRAFT_ID;

if (!DISCORD_TOKEN) throw new Error("❌ DISCORD_TOKEN manquant dans .env");
if (!NBA_API_KEY) throw new Error("❌ NBA_API_KEY manquant dans .env");
if (!CHANNEL_MATCH_DU_JOUR) throw new Error("❌ CHANNEL_MATCH_DU_JOUR manquant dans .env");
if (!CHANNEL_SCORES_ID) throw new Error("❌ CHANNEL_SCORES_ID manquant dans .env");

// ---- Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ======================
// STATE (anti-spam même après restart)
// ======================
const STATE_FILE = "./state.json";
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return { posted: {}, lastScheduleDatePosted: null }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const state = loadState();

function shouldPost(key, signature) {
  const prev = state.posted[key];
  if (prev === signature) return false;
  state.posted[key] = signature;
  saveState(state);
  return true;
}

// ======================
// DATE PARIS (NORMAL + TEST COMMENTÉ)
// ======================
function parisDateYYYYMMDD() {
  // ✅ VERSION NORMALE (temps réel Paris)
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

  // return `${yyyy}-${mm}-${dd}`;

  // ===========================
  // 🧪 VERSION TEST (décommenter pour forcer une date)
  return "2024-12-25"; // Christmas games
  // return "2024-02-08"; // Trade deadline (si tu testes autre chose)
  // ===========================
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

// ======================
// LOGOS (PNG pour Discord)
// ======================
function espnLogoPng(abbr) {
  const a = (abbr || "").toLowerCase();
  return a ? `https://a.espncdn.com/i/teamlogos/nba/500/${a}.png` : null;
}

// ======================
// TIME FORMAT (Paris)
// ======================
function formatTipoffParis(isoDate) {
  if (!isoDate) return "Heure inconnue";
  const d = new Date(isoDate);

  const hm = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  const day = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(d);

  return `${day} • ${hm} (Paris)`;
}

// ======================
// BALLDONTLIE
// ======================
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

// ======================
// EMBEDS (beaux)
// ======================
function gameScheduleEmbed(g, dateLabel) {
  const home = g.home_team?.abbreviation ?? "HOME";
  const away = g.visitor_team?.abbreviation ?? "AWAY";

  const tipoff = formatTipoffParis(g.date);
  const status = g.status ?? "TBD";

  const awayLogo = espnLogoPng(away);
  const homeLogo = espnLogoPng(home);

  const e = new EmbedBuilder()
    .setTitle(`${away} @ ${home}`)
    .setDescription(`🕒 **${tipoff}**\n📌 **${status}**`)
    .setFooter({ text: `Programme NBA — ${dateLabel}` })
    .setTimestamp(new Date());

  if (awayLogo) e.setAuthor({ name: away, iconURL: awayLogo });
  if (homeLogo) e.setThumbnail(homeLogo);

  return e;
}

function gameScoreEmbed(g, dateLabel) {
  const home = g.home_team?.abbreviation ?? "HOME";
  const away = g.visitor_team?.abbreviation ?? "AWAY";
  const hs = g.home_team_score ?? 0;
  const as = g.visitor_team_score ?? 0;

  const tipoff = formatTipoffParis(g.date);
  const status = g.status ?? "TBD";

  const awayLogo = espnLogoPng(away);
  const homeLogo = espnLogoPng(home);

  const e = new EmbedBuilder()
    .setTitle(`${away} @ ${home}`)
    .setDescription(`**${away} ${as} — ${hs} ${home}**\n🕒 ${tipoff}\n📌 ${status}`)
    .setFooter({ text: `Scores live — ${dateLabel}` })
    .setTimestamp(new Date());

  if (awayLogo) e.setAuthor({ name: away, iconURL: awayLogo });
  if (homeLogo) e.setThumbnail(homeLogo);

  return e;
}

// ======================
// PROGRAMME -> CHANNEL_MATCH_DU_JOUR
// ======================
async function postDailyScheduleIfNeeded(matchDuJourChannel) {
  const date = parisDateYYYYMMDD();
  if (state.lastScheduleDatePosted === date) return;

  const games = await fetchGamesByDate(date);
  state.lastScheduleDatePosted = date;
  saveState(state);

  if (!games.length) {
    const e = new EmbedBuilder()
      .setTitle(`📅 Programme NBA — ${date}`)
      .setDescription("Aucun match prévu ce jour-là.")
      .setTimestamp(new Date());

    await matchDuJourChannel.send({ embeds: [e] });
    return;
  }

  // Init anti-spam score pour éviter spam au 1er poll
  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;
    state.posted[`score_${gameId}`] = signature;
  }
  saveState(state);

  // Header
  const header = new EmbedBuilder()
    .setTitle(`📅 Programme NBA — ${date}`)
    .setDescription(`Matchs du jour : **${games.length}**`)
    .setTimestamp(new Date());

  await matchDuJourChannel.send({ embeds: [header] });

  // 1 embed par match (Discord limite 10 embeds par message)
  const embeds = games.map(g => gameScheduleEmbed(g, date));
  for (let i = 0; i < embeds.length; i += 10) {
    await matchDuJourChannel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

// ======================
// SCORES LIVE -> CHANNEL_SCORES_ID
// ======================
async function pollAndPostScoreUpdates(scoresChannel) {
  const date = parisDateYYYYMMDD();
  const games = await fetchGamesByDate(date);
  if (!games.length) return;

  const changed = [];

  for (const g of games) {
    const gameId = String(g.id);
    const signature = `${g.visitor_team_score}-${g.home_team_score}-${g.status}`;

    if (shouldPost(`score_${gameId}`, signature)) {
      const st = (g.status ?? "").toLowerCase();
      const isInteresting =
        st.includes("final") ||
        st.includes("q") ||
        st.includes("half") ||
        st.includes("ot");

      if (isInteresting) changed.push(g);
    }
  }

  if (!changed.length) return;

  const embeds = changed.map(g => gameScoreEmbed(g, date));
  for (let i = 0; i < embeds.length; i += 10) {
    await scoresChannel.send({
      content: i === 0 ? "🏀 **Update scores**" : undefined,
      embeds: embeds.slice(i, i + 10),
    });
  }
}

// ======================
// Injuries / News (inchangé)
// ======================
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
  const json = await fetchInjuriesPage(null);
  const injuries = json.data ?? [];
  if (!injuries.length) return;

  const lines = [];
  for (const i of injuries.slice(0, 20)) {
    const id = String(i.id ?? `${i.player?.id}-${i.team?.id}-${i.status}`);
    const sig = `${i.status}|${i.description ?? ""}|${i.updated_at ?? ""}`;
    if (shouldPost(`injury_${id}`, sig)) lines.push(formatInjury(i));
  }

  if (lines.length) {
    const embed = new EmbedBuilder()
      .setTitle("🩺 Injury update")
      .setDescription(lines.join("\n"))
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
  }
}

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
        const embed = new EmbedBuilder()
          .setTitle("🔁 Trade / Transaction")
          .setDescription(`**${title}**\n${link}`)
          .setTimestamp(new Date());
        await tradeChannel.send({ embeds: [embed] });
      }
    } else if (isDraft && draftChannel) {
      if (shouldPost(`news_draft_${id}`, title)) {
        const embed = new EmbedBuilder()
          .setTitle("🧢 Draft")
          .setDescription(`**${title}**\n${link}`)
          .setTimestamp(new Date());
        await draftChannel.send({ embeds: [embed] });
      }
    }
  }
}

// ======================
// BOOT
// ======================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  const matchDuJourChannel = await client.channels.fetch(CHANNEL_MATCH_DU_JOUR);
  if (!matchDuJourChannel?.isTextBased()) throw new Error("❌ CHANNEL_MATCH_DU_JOUR n'est pas un salon texte");

  const scoresChannel = await client.channels.fetch(CHANNEL_SCORES_ID);
  if (!scoresChannel?.isTextBased()) throw new Error("❌ CHANNEL_SCORES_ID n'est pas un salon texte");

  const injuryChannel = CHANNEL_INJURY_ID ? await client.channels.fetch(CHANNEL_INJURY_ID) : null;
  const tradeChannel  = CHANNEL_TRADE_ID  ? await client.channels.fetch(CHANNEL_TRADE_ID)  : null;
  const draftChannel  = CHANNEL_DRAFT_ID  ? await client.channels.fetch(CHANNEL_DRAFT_ID)  : null;

  if (injuryChannel && !injuryChannel.isTextBased()) throw new Error("❌ CHANNEL_INJURY_ID n'est pas un salon texte");
  if (tradeChannel && !tradeChannel.isTextBased())   throw new Error("❌ CHANNEL_TRADE_ID n'est pas un salon texte");
  if (draftChannel && !draftChannel.isTextBased())   throw new Error("❌ CHANNEL_DRAFT_ID n'est pas un salon texte");

  // 1) Au démarrage : programme du jour -> channel match_du_jour
  await postDailyScheduleIfNeeded(matchDuJourChannel).catch(console.error);

  // 2) Scores toutes les 5 minutes -> channel scores
  setInterval(() => {
    pollAndPostScoreUpdates(scoresChannel).catch(console.error);
  }, 5 * 60 * 1000);

  // 3) Programme à 09:00 (Paris) -> channel match_du_jour
  setInterval(() => {
    const { hh, mi } = parisHourMinute();
    if (hh === 9 && mi === 0) {
      postDailyScheduleIfNeeded(matchDuJourChannel).catch(console.error);
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
