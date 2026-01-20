require("dotenv").config();
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

function extractBattleId(input) {
  const m = String(input).match(/battles\/(\d+)/);
  return m ? m[1] : /^\d+$/.test(input) ? input : null;
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
      if (!battleId) {
        return message.reply("❌ Invalid battle link or ID.");
      }

      const battle = await fetchBattle(battleId);
      const albionNames = extractGuildPlayers(battle, guildName);

      if (albionNames.length === 0) {
        return message.channel.send(
          `❌ No players found for **${guildName}**.`,
        );
      }

      const members = await message.guild.members.fetch();
      const unmatched = [];
      const matched = new Map();

      for (const name of albionNames) {
        let best = null;
        let bestScore = 0;

        for (const m of members.values()) {
          const score = Math.max(
            similarity(name, m.nickname),
            similarity(name, m.user.globalName),
            similarity(name, m.user.username),
          );

          if (score > bestScore) {
            bestScore = score;
            best = m;
          }
        }

        if (bestScore < 0.86) {
          unmatched.push(name);
        } else {
          matched.set(name, best);
        }
      }

      if (unmatched.length > 0) {
        return message.channel.send(
          `❌ **No pings sent.** Unmatched players:\n- ${unmatched.join(
            "\n- ",
          )}`,
        );
      }

      await message.channel.send(
        `✅ All matched. Pinging ${matched.size} players...`,
      );

      for (const [name, member] of matched.entries()) {
        await message.channel.send(`🔔 ${member} (**${name}**)`);
        await sleep(1200);
      }
    }
  } catch (e) {
    console.error(e);
    message.channel.send("❌ Error. Check console.");
  }
});

client.login(TOKEN);
