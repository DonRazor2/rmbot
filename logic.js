// Small helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
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

function dedupeClean(names) {
  return [
    ...new Set((names || []).map((n) => String(n).trim()).filter(Boolean)),
  ];
}

// AlbionBB parsing (NUXT)
function extractBattleIds(input) {
  const s = String(input || "").trim();

  // Multi: /battles/multi?ids=1,2,3
  const multi = s.match(/\/battles\/multi\?[^#]*\bids=([0-9,]+)/i);
  if (multi) {
    return multi[1]
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^\d+$/.test(x));
  }

  // Single: /battles/<id>
  const single = s.match(/\/battles\/(\d+)/i);
  if (single) return [single[1]];

  // Raw: "id,id,id" or "id"
  if (/^\d+(,\d+)*$/.test(s)) {
    return s.split(",").map((x) => x.trim());
  }

  return null;
}

async function fetchBattleHtml(battleId) {
  const url = `https://europe.albionbb.com/battles/${battleId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`AlbionBB HTTP ${res.status}`);
  return res.text();
}

function extractNuxtArrayFromHtml(html) {
  const re = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(re);
  if (!m) throw new Error("Could not find __NUXT_DATA__ in HTML");

  const parsed = JSON.parse(m[1].trim());
  if (!Array.isArray(parsed)) {
    throw new Error("__NUXT_DATA__ did not parse into an array");
  }
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
      for (const [k, val] of Object.entries(r))
        out[k] = deepResolve(val, depth + 1);
      return out;
    }
    return r;
  };

  return { deepResolve };
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
  if (!Array.isArray(playersList)) {
    throw new Error("battleRoot.players did not resolve to an array");
  }

  const target = norm(guildName);
  const names = [];

  for (const entry of playersList) {
    const p = deepResolve(entry);
    if (!p || typeof p !== "object") continue;

    if (norm(p.guildName) !== target) continue;

    const name = String(p.name || "").trim();
    if (name) names.push(name);
  }

  return dedupeClean(names);
}

async function getGuildPlayersFromBattle(battleId, guildName) {
  const html = await fetchBattleHtml(battleId);
  const nuxtArr = extractNuxtArrayFromHtml(html);
  return extractGuildPlayersFromNuxt(nuxtArr, guildName);
}

async function getGuildPlayersFromBattles(battleIds, guildName) {
  const out = new Set();
  for (const id of battleIds) {
    const names = await getGuildPlayersFromBattle(id, guildName);
    for (const n of names) out.add(String(n).trim());
  }
  return [...out].filter(Boolean);
}

// Mapping (STRICT) - shared by map-bb and map-bb-add-role
async function strictMapAlbionToDiscordMembers({ guild, albionNames }) {
  const threshold = 0.86;
  const ambGap = 0.06;

  const members = await guild.members.fetch();

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

  return {
    ok: problems.length === 0 && matched.size === albionNames.length,
    matched,
    problems: [...new Set(problems.filter(Boolean))],
  };
}

// Role helpers
function assertRoleEditableByBot(role, me) {
  if (role.position >= me.roles.highest.position) {
    throw new Error("❌ That role is above (or equal to) my highest role.");
  }
}

async function addRoleToMembers({ role, membersIterable }) {
  let added = 0;
  let alreadyHad = 0;

  for (const member of membersIterable) {
    if (member.roles.cache.has(role.id)) {
      alreadyHad++;
      continue;
    }
    await member.roles.add(role);
    added++;
    await sleep(800);
  }

  return { added, alreadyHad };
}

// Command implementations
async function cmdAddRole({ message, args, PREFIX, me }) {
  const role = message.mentions.roles.first();
  const members = message.mentions.members;

  if (!role || members.size === 0) {
    return message.reply(
      `Usage: \`${PREFIX}add-role @Role @User1 @User2 ...\``,
    );
  }

  assertRoleEditableByBot(role, me);

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

async function cmdClearRole({ message, PREFIX, me }) {
  const role = message.mentions.roles.first();
  if (!role) return message.reply(`Usage: \`${PREFIX}clear-role @Role\``);

  assertRoleEditableByBot(role, me);

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

async function cmdMapBb({ message, args, PREFIX, DEFAULT_GUILD_NAME }) {
  const battleInput = args[0];
  const guildName = args.slice(1).join(" ") || DEFAULT_GUILD_NAME;

  if (!battleInput) {
    return message.reply(
      `Usage: \`${PREFIX}map-bb <albionbb link> [guild name]\``,
    );
  }

  const battleIds = extractBattleIds(battleInput);
  if (!battleIds || battleIds.length === 0) {
    return message.reply("❌ Invalid battle link or ID.");
  }

  const battleLabel =
    battleIds.length === 1
      ? battleIds[0]
      : `multi (${battleIds.length} battles)`;

  await message.reply(
    `Fetching Nuxt data for **${battleLabel}** (guild: **${guildName}**)…`,
  );

  let albionNames;
  try {
    albionNames = await getGuildPlayersFromBattles(battleIds, guildName);
  } catch (e) {
    return message.channel.send(`❌ Nuxt parse error: ${e.message}`);
  }

  albionNames = dedupeClean(albionNames);
  if (albionNames.length === 0) {
    return message.channel.send(
      `❌ No players found for **${guildName}** in Nuxt data.`,
    );
  }

  const mapping = await strictMapAlbionToDiscordMembers({
    guild: message.guild,
    albionNames,
  });

  if (!mapping.ok) {
    const extracted = albionNames.length;
    const matchedCount = mapping.matched.size;
    const missing = extracted - matchedCount;

    let out =
      `❌ **Strict mode: no mapped list produced.**\n` +
      `Battle: **${battleLabel}** | Guild: **${guildName}**\n` +
      `Extracted: **${extracted}** | Matched: **${matchedCount}** | Missing: **${missing}**\n\n` +
      `**Problems (${mapping.problems.length}):**\n- ${mapping.problems.join("\n- ")}`;

    if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
    return message.channel.send(out);
  }

  const lines = albionNames.map((albion) => {
    const m = mapping.matched.get(albion);
    return `${m.displayName} (Albion: ${albion})`;
  });

  let out =
    `✅ All matched (names only).\n` +
    `Battle: **${battleLabel}** | Guild: **${guildName}** | Count: **${lines.length}**\n\n` +
    lines.join("\n");

  if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
  return message.channel.send(out);
}

async function cmdMapBbAddRole({
  message,
  args,
  PREFIX,
  DEFAULT_GUILD_NAME,
  me,
}) {
  const battleInput = args[0];
  const role = message.mentions.roles.first();

  const guildName =
    args
      .slice(1)
      .filter((x) => !x.startsWith("<@&"))
      .join(" ")
      .trim() || DEFAULT_GUILD_NAME;

  if (!battleInput || !role) {
    return message.reply(
      `Usage: \`${PREFIX}map-bb-add-role <albionbb link> @Role [guild name]\``,
    );
  }

  const battleIds = extractBattleIds(battleInput);
  if (!battleIds || battleIds.length === 0) {
    return message.reply("❌ Invalid battle link or ID.");
  }

  const battleLabel =
    battleIds.length === 1
      ? battleIds[0]
      : `multi (${battleIds.length} battles)`;

  assertRoleEditableByBot(role, me);

  await message.reply(
    `Mapping **${battleLabel}** for guild **${guildName}**, then adding role **${role.name}**…`,
  );

  // Reuse map-bb logic: extract -> strict map
  let albionNames;
  try {
    albionNames = await getGuildPlayersFromBattles(battleIds, guildName);
  } catch (e) {
    return message.channel.send(`❌ Nuxt parse error: ${e.message}`);
  }

  albionNames = dedupeClean(albionNames);
  if (albionNames.length === 0) {
    return message.channel.send(
      `❌ No players found for **${guildName}** in Nuxt data.`,
    );
  }

  const mapping = await strictMapAlbionToDiscordMembers({
    guild: message.guild,
    albionNames,
  });

  // STRICT: if any mapping problem -> no role changes
  if (!mapping.ok) {
    const extracted = albionNames.length;
    const matchedCount = mapping.matched.size;
    const missing = extracted - matchedCount;

    let out =
      `❌ **Strict mode: no roles were added.**\n` +
      `Battle: **${battleLabel}** | Guild: **${guildName}** | Role: **${role.name}**\n` +
      `Extracted: **${extracted}** | Matched: **${matchedCount}** | Missing: **${missing}**\n\n` +
      `**Problems (${mapping.problems.length}):**\n- ${mapping.problems.join("\n- ")}`;

    if (out.length > 1900) out = out.slice(0, 1900) + "\n…(truncated)";
    return message.channel.send(out);
  }

  // All matched: add role
  const { added, alreadyHad } = await addRoleToMembers({
    role,
    membersIterable: mapping.matched.values(),
  });

  return message.channel.send(
    `✅ Added **${role.name}** to **${added}** member(s). (${alreadyHad} already had it.)`,
  );
}

// ------------------------------------------------------------
// handleCommand()
// Central router for all bot commands.
// Called from index.js AFTER:
//  - prefix parsing (cmd + args extracted)
//  - basic guild/bot checks (no DMs, ignore bots)
//  - permission checks (you + bot must have Manage Roles)
//
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
async function handleCommand({
  message,
  cmd,
  args,
  me,
  PREFIX,
  DEFAULT_GUILD_NAME,
}) {
  if (cmd === "add-role") return cmdAddRole({ message, args, PREFIX, me });
  if (cmd === "clear-role") return cmdClearRole({ message, PREFIX, me });
  if (cmd === "map-bb")
    return cmdMapBb({ message, args, PREFIX, DEFAULT_GUILD_NAME });
  if (cmd === "map-bb-add-role")
    return cmdMapBbAddRole({ message, args, PREFIX, DEFAULT_GUILD_NAME, me });

  return;
}

module.exports = { handleCommand };
