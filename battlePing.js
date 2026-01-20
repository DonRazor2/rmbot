// copy paste idk how it does it but it matches albion online player names to discord members
function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); // strip spaces/symbols to improve fuzzy matching
}

// Simple Levenshtein distance (no deps)
function levenshtein(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1, // delete
        dp[j - 1] + 1, // insert
        prev + cost, // replace
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function similarityScore(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;

  if (na === nb) return 1;

  // If one contains the other, treat as very strong match
  if (na.includes(nb) || nb.includes(na)) return 0.92;

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function extractBattleId(urlOrId) {
  const s = String(urlOrId || "").trim();
  const m = s.match(/\/battles\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

async function fetchBattlePlayersFromGameinfoEU(battleId) {
  // EU endpoint (Amsterdam)
  const url = `https://gameinfo-ams.albiononline.com/api/gameinfo/battles/${battleId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (DiscordBot; battle ping helper)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gameinfo request failed (${res.status}): ${text.slice(0, 120)}`,
    );
  }

  return res.json();
}

function getGuildPlayersFromBattleJson(battleJson, targetGuildName) {
  // The battle json has "players" object in typical formats.
  // we'll support a few shapes, since endpoints sometimes differ.
  const guildLower = (targetGuildName || "").toLowerCase();

  const players = [];

  // Common: battleJson.players = { "PlayerName": { Name, GuildName, AllianceName, ... } }
  if (
    battleJson &&
    battleJson.players &&
    typeof battleJson.players === "object"
  ) {
    for (const key of Object.keys(battleJson.players)) {
      const p = battleJson.players[key];
      const name = p?.Name || key;
      const guild = (p?.GuildName || p?.Guild || "").toLowerCase();
      if (guild && guild === guildLower) players.push(name);
    }
  }

  // Some variants may include arrays
  if (players.length === 0 && Array.isArray(battleJson?.Players)) {
    for (const p of battleJson.Players) {
      const name = p?.Name;
      const guild = (p?.GuildName || "").toLowerCase();
      if (name && guild === guildLower) players.push(name);
    }
  }

  // De-dupe
  return Array.from(new Set(players));
}

async function buildDiscordMemberIndex(guild) {
  // Fetch all members so we can fuzzy-match reliably
  const members = await guild.members.fetch();

  // Precompute candidate strings for each member: nickname + username + global name
  return members.map((m) => {
    const user = m.user;
    return {
      id: m.id,
      tag: user.tag,
      username: user.username,
      globalName: user.globalName || "",
      nickname: m.nickname || "",
      member: m,
      candidates: [
        m.nickname || "",
        user.globalName || "",
        user.username || "",
      ].filter(Boolean),
    };
  });
}

function matchAlbionNamesToDiscordMembers(albionNames, memberIndex, opts = {}) {
  const threshold = opts.threshold ?? 0.86; // tune: higher = stricter
  const ambiguousGap = opts.ambiguousGap ?? 0.06; // if #1 and #2 too close => ambiguous

  const matched = new Map(); // albionName -> member
  const unmatched = [];
  const ambiguous = [];

  const usedMemberIds = new Set();

  for (const albionName of albionNames) {
    let best = null;
    let second = null;

    for (const entry of memberIndex) {
      // Prevent mapping two Albion names to the same Discord member (common safety)
      if (usedMemberIds.has(entry.id)) continue;

      let score = 0;
      for (const cand of entry.candidates) {
        score = Math.max(score, similarityScore(albionName, cand));
      }

      const rec = { entry, score };

      if (!best || rec.score > best.score) {
        second = best;
        best = rec;
      } else if (!second || rec.score > second.score) {
        second = rec;
      }
    }

    if (!best || best.score < threshold) {
      unmatched.push(albionName);
      continue;
    }

    if (second && best.score - second.score < ambiguousGap) {
      ambiguous.push({
        albionName,
        best: { tag: best.entry.tag, score: best.score },
        second: { tag: second.entry.tag, score: second.score },
      });
      continue;
    }

    matched.set(albionName, best.entry.member);
    usedMemberIds.add(best.entry.id);
  }

  return { matched, unmatched, ambiguous };
}

module.exports = {
  extractBattleId,
  fetchBattlePlayersFromGameinfoEU,
  getGuildPlayersFromBattleJson,
  buildDiscordMemberIndex,
  matchAlbionNamesToDiscordMembers,
};
