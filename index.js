require("dotenv").config();

const { extractBattleId, getGuildPlayersFromBattle } = require("./albionbb");

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const PREFIX = process.env.PREFIX || "!";
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

async function fetchBattle(battleId) {
  const res = await fetch(
    `https://gameinfo-ams.albiononline.com/api/gameinfo/battles/${battleId}`,
  );
  if (!res.ok) throw new Error(`Albion API failed (${res.status})`);
  return res.json();
}

function extractGuildPlayers(battle, guildName) {
  const out = [];
  if (!battle.players) return out;
  for (const p of Object.values(battle.players)) {
    if (p.GuildName?.toLowerCase() === guildName.toLowerCase()) {
      out.push(p.Name);
    }
  }
  return [...new Set(out)];
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// handlerr
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return message.reply("❌ You need **Manage Roles**.");
    }

    const me = await message.guild.members.fetchMe();
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply("❌ I need **Manage Roles**.");
    }

    // add roles to mentioned members
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

    // clear roles from ALL members
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

    // ping guild doesn't work because idk why
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

      let albionNames;
      try {
        albionNames = await getGuildPlayersFromBattle(battleId, guildName);
      } catch (e) {
        return message.channel.send(
          `❌ Failed to fetch/parse Nuxt data: ${e.message}`,
        );
      }

      if (!albionNames || albionNames.length === 0) {
        return message.channel.send(
          `❌ No players found for **${guildName}** in Nuxt data.`,
        );
      }

      const members = await message.guild.members.fetch();

      const threshold = 0.86;
      const ambGap = 0.06;

      const matched = new Map(); // albionName -> GuildMember
      const problems = [];
      const usedMemberIds = new Set();

      for (const name of albionNames) {
        let best = null;
        let bestScore = 0;
        let secondScore = 0;

        for (const m of members.values()) {
          if (usedMemberIds.has(m.id)) continue;

          const score = Math.max(
            similarity(name, m.nickname),
            similarity(name, m.user.globalName),
            similarity(name, m.user.username),
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

      // STRICT: if any mismatch, do NOT output mapped list
      if (problems.length > 0 || matched.size !== albionNames.length) {
        let out =
          `❌ **Strict mode: no mapped list produced.**\n` +
          `Battle: **${battleId}** | Guild: **${guildName}**\n` +
          `Extracted: **${albionNames.length}** | Matched: **${matched.size}**\n\n` +
          `**Problems:**\n- ${problems.join("\n- ")}`;

        if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
        return message.channel.send(out);
      }

      // ONE message, names only (no @mentions yet)
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
    console.error(e);
    message.channel.send("❌ Error. Check console.");
  }
});

client.login(TOKEN);
