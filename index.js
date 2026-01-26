require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const { handleCommand } = require("./botLogic");

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

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    // Same behavior as before: all your commands require Manage Roles
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return message.reply("❌ You need **Manage Roles**.");
    }

    const me = await message.guild.members.fetchMe();
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply("❌ I need **Manage Roles**.");
    }

    // Supported commands (all use the PREFIX from .env or default):
    //
    // 1) add-role
    //    Usage:   <PREFIX>add-role @Role @User1 @User2 ...
    //    What it does:
    //      - Adds the mentioned role to each mentioned user.
    //      - Skips users who already have the role.
    //      - Adds one-by-one with a short delay (rate-limit friendly).
    //
    // 2) clear-role
    //    Usage:   <PREFIX>clear-role @Role
    //    What it does:
    //      - Removes the mentioned role from EVERY member who has it.
    //      - Removes one-by-one with a short delay (rate-limit friendly).
    //
    // 3) map-bb
    //    Usage:   <PREFIX>map-bb <albionbb link | id | multi link | "id,id,..."> [guild name]
    //    Examples:
    //      - <PREFIX>map-bb https://europe.albionbb.com/battles/313321164 Romania Mare
    //      - <PREFIX>map-bb https://europe.albionbb.com/battles/multi?ids=1,2,3 Romania Mare
    //    What it does:
    //      - Fetches AlbionBB HTML for the battle(s) with a browser User-Agent.
    //      - Extracts the "__NUXT_DATA__" JSON, then pulls player names for the given guild.
    //      - STRICT matching: maps each Albion name to exactly ONE Discord member
    //        using nickname/globalName/username + fuzzy matching.
    //      - If ANY name is unmatched/ambiguous, it posts an error list and outputs no mapping.
    //      - If ALL match, it prints a "DiscordName (Albion: AlbionName)" list (names only).
    //
    // 4) map-bb-add-role
    //    Usage:   <PREFIX>map-bb-add-role <albionbb link | id | multi link | "id,id,..."> @Role [guild name]
    //    Example:
    //      - <PREFIX>map-bb-add-role https://europe.albionbb.com/battles/313321164 @pay1 Romania Mare
    //    What it does:
    //      - Runs the SAME strict mapping logic as map-bb (extract -> strict map).
    //      - STRICT all-or-nothing: if ANY mapping fails (unmatched/ambiguous),
    //        it adds NO roles and prints the problem list.
    //      - If ALL match, it adds the role to every matched Discord member (one-by-one).
    //
    // Note: Unknown commands are ignored (no reply).
    // ------------------------------------------------------------
    await handleCommand({
      message,
      cmd,
      args,
      me,
      PREFIX,
      DEFAULT_GUILD_NAME,
    });
  } catch (e) {
    console.error("ERROR:", e?.message);
    console.error(e);
    return message.channel.send("❌ Error. Check console.");
  }
});

client.login(TOKEN);
