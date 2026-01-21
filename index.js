require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const PREFIX = process.env.PREFIX || "$";
const TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_GUILD_NAME = "Romania Mare";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== STRING MATCHING HELPERS =====
function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a, b) {
  const dp = Array(b.length + 1)
    .fill(0)
    .map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return dp[b.length];
}

function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// ===== ALBIONBB + NUXT HELPERS =====
function extractBattleId(input) {
  const s = String(input || "").trim();
  const m = s.match(/\/battles\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

async function fetchBattleHtml(battleId) {
  const url = `https://europe.albionbb.com/battles/${battleId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`AlbionBB HTTP ${res.status}`);
  return res.text();
}

function extractNuxtArrayFromHtml(html) {
  const re = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(re);
  if (!m) throw new Error("Could not find __NUXT_DATA__ in HTML");
  const jsonText = m[1].trim();
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed))
    throw new Error("__NUXT_DATA__ did not parse into an array");
  return parsed;
}

function makeResolver(arr) {
  const resolve = (v) => {
    if (typeof v === "number" && v >= 0 && v < arr.length) return arr[v];
    return v;
  };

  const deepResolve = (v, depth = 0) => {
    if (depth > 6) return v; // safety
    const r = resolve(v);

    if (Array.isArray(r)) return r.map((x) => deepResolve(x, depth + 1));
    if (r && typeof r === "object") {
      const out = {};
      for (const [k, val] of Object.entries(r)) {
        out[k] = deepResolve(val, depth + 1);
      }
      return out;
    }
    return r;
  };

  return { resolve, deepResolve };
}

function findBattleRoot(arr) {
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const hasPlayers = Object.prototype.hasOwnProperty.call(item, "players");
    const hasGuilds = Object.prototype.hasOwnProperty.call(item, "guilds");
    const hasTotalPlayers = Object.prototype.hasOwnProperty.call(
      item,
      "totalPlayers",
    );

    if (hasPlayers && hasGuilds && hasTotalPlayers) return item;
  }
  throw new Error("Could not locate battle root object in Nuxt data");
}

function extractGuildPlayersFromNuxt(arr, guildName) {
  const { deepResolve } = makeResolver(arr);
  const battleRoot = findBattleRoot(arr);

  const playersList = deepResolve(battleRoot.players);
  if (!Array.isArray(playersList))
    throw new Error("battleRoot.players did not resolve to an array");

  const target = norm(guildName);
  const names = [];

  for (const entry of playersList) {
    const p = deepResolve(entry);
    if (!p || typeof p !== "object") continue;

    if (norm(p.guildName) !== target) continue;

    const name = String(p.name || "").trim();
    if (name) names.push(name);
  }

  // Clean + de-dupe (prevents Deskra twice / blanks)
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

async function getGuildPlayersFromBattle(battleId, guildName) {
  const html = await fetchBattleHtml(battleId);
  const nuxtArr = extractNuxtArrayFromHtml(html);
  return extractGuildPlayersFromNuxt(nuxtArr, guildName);
}

// ===== BOT READY =====
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===== MESSAGE HANDLER =====
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    // Permission checks (role commands and ping-guild both need Manage Roles in your setup)
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return message.reply("❌ You need **Manage Roles**.");
    }

    const me = await message.guild.members.fetchMe();
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply("❌ I need **Manage Roles**.");
    }

    // ===============================
    // ADD ROLE TO MULTIPLE USERS
    // ===============================
    if (cmd === "add-role") {
      const role = message.mentions.roles.first();
      const members = message.mentions.members;

      if (!role || members.size === 0) {
        return message.reply(
          `Usage: \`${PREFIX}add-role @Role @User1 @User2 ...\``,
        );
      }

      if (role.position >= me.roles.highest.position) {
        return message.reply("❌ Role is above my highest role.");
      }

      let added = 0;
      for (const m of members.values()) {
        if (!m.roles.cache.has(role.id)) {
          await m.roles.add(role);
          added++;
          await sleep(800);
        }
      }

      return message.channel.send(`✅ Added role to ${added} users.`);
    }

    // ===============================
    // CLEAR ROLE FROM EVERYONE
    // ===============================
    if (cmd === "clear-role") {
      const role = message.mentions.roles.first();
      if (!role) {
        return message.reply(`Usage: \`${PREFIX}clear-role @Role\``);
      }

      const members = await message.guild.members.fetch();
      const targets = members.filter((m) => m.roles.cache.has(role.id));

      let removed = 0;
      for (const m of targets.values()) {
        await m.roles.remove(role);
        removed++;
        await sleep(800);
      }

      return message.channel.send(
        `🧹 Removed **${role.name}** from ${removed} members.`,
      );
    }

    // ===============================
    // PING-GUILD (TEST MODE: NAMES ONLY)
    // ===============================
    if (cmd === "ping-guild") {
      const battleInput = args[0];
      const guildName = args.slice(1).join(" ") || DEFAULT_GUILD_NAME;

      if (!battleInput) {
        return message.reply(
          `Usage: \`${PREFIX}ping-guild <albionbb link> [guild name]\``,
        );
      }

      const battleId = extractBattleId(battleInput);
      if (!battleId) return message.reply("❌ Invalid battle link or ID.");

      await message.reply(
        `Fetching Nuxt data for battle **${battleId}** (guild: **${guildName}**)…`,
      );

      // Always local variables (prevents accumulating repeats across runs)
      let albionNames;
      try {
        albionNames = await getGuildPlayersFromBattle(battleId, guildName);
      } catch (e) {
        return message.channel.send(`❌ Nuxt parse error: ${e.message}`);
      }

      // Clean again just in case
      albionNames = [
        ...new Set(albionNames.map((n) => String(n).trim()).filter(Boolean)),
      ];

      if (albionNames.length === 0) {
        return message.channel.send(
          `❌ No players found for **${guildName}** in Nuxt data.`,
        );
      }

      const members = await message.guild.members.fetch();

      // Matching settings
      const threshold = 0.86;
      const ambGap = 0.06;

      const problems = [];
      const matched = new Map(); // albionName -> GuildMember
      const usedMemberIds = new Set();

      for (const name of albionNames) {
        let best = null;
        let bestScore = 0;
        let secondScore = 0;

        const nn = normalize(name);

        for (const m of members.values()) {
          if (usedMemberIds.has(m.id)) continue;

          const nick = m?.nickname ?? "";
          const gname = m?.user?.globalName ?? "";
          const uname = m?.user?.username ?? "";

          // Exact normalized match shortcut
          if (
            nn &&
            (normalize(nick) === nn ||
              normalize(gname) === nn ||
              normalize(uname) === nn)
          ) {
            best = m;
            bestScore = 1;
            secondScore = 0;
            break;
          }

          const score = Math.max(
            similarity(name, nick),
            similarity(name, gname),
            similarity(name, uname),
          );

          if (score > bestScore) {
            secondScore = bestScore;
            bestScore = score;
            best = m;
          } else if (score > secondScore) {
            secondScore = score;
          }
        }

        if (!best || bestScore < threshold) {
          problems.push(`Unmatched: ${name}`);
          continue;
        }
        if (bestScore - secondScore < ambGap) {
          problems.push(`Ambiguous: ${name}`);
          continue;
        }

        matched.set(name, best);
        usedMemberIds.add(best.id);
      }

      // STRICT MODE: no mapped list if any problems
      if (problems.length > 0 || matched.size !== albionNames.length) {
        const uniqueProblems = [...new Set(problems.filter(Boolean))];

        const extracted = albionNames.length;
        const matchedCount = matched.size;
        const missing = extracted - matchedCount;

        let out =
          `❌ **Strict mode: no mapped list produced.**\n` +
          `Battle: **${battleId}** | Guild: **${guildName}**\n` +
          `Extracted: **${extracted}** | Matched: **${matchedCount}** | Missing: **${missing}**\n\n` +
          `**Problems (${uniqueProblems.length}):**\n- ${uniqueProblems.join("\n- ")}`;

        if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
        return message.channel.send(out);
      }

      // ONE MESSAGE OUTPUT — names only (no @mentions yet)
      const lines = albionNames.map((albion) => {
        const m = matched.get(albion);
        return `${m.displayName} (Albion: ${albion})`;
      });

      let out =
        `✅ All matched (names only).\n` +
        `Battle: **${battleId}** | Guild: **${guildName}** | Count: **${lines.length}**\n\n` +
        lines.join("\n");

      if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
      return message.channel.send(out);
    }
  } catch (e) {
    console.error("ERROR:", e?.message);
    console.error(e);
    return message.channel.send("❌ Error. Check console.");
  }
});

client.login(TOKEN);
