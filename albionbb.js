// albionbb.js
// Fetches https://europe.albionbb.com/battles/<id>
// Extracts Nuxt __NUXT_DATA__ JSON (array-based, index-referenced)
// Returns all player names for a given guild name (e.g. "Romania Mare")

function extractBattleId(input) {
  const s = String(input || "").trim();
  const m = s.match(/\/battles\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

async function fetchBattleHtml(battleId) {
  const url = `https://europe.albionbb.com/battles/${battleId}`;
  const res = await fetch(url, {
    headers: {
      // mimic your Postman request
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`AlbionBB HTTP ${res.status}`);
  return res.text();
}

function extractNuxtDataJson(html) {
  // Grab the content inside:
  // <script type="application/json" id="__NUXT_DATA__"> ... </script>
  // We'll use a regex that targets that tag specifically.
  const re = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(re);
  if (!m) throw new Error("Could not find __NUXT_DATA__ script tag in HTML");

  const jsonText = m[1].trim();
  // Nuxt data is valid JSON (usually a top-level array).
  return JSON.parse(jsonText);
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Resolve numeric references into the big array.
// If v is a number and points to an existing entry, return arr[v], else v.
function makeResolver(arr) {
  const resolve = (v) => {
    if (typeof v === "number" && v >= 0 && v < arr.length) return arr[v];
    return v;
  };

  const deepResolve = (v, depth = 0) => {
    if (depth > 6) return v; // safety against weird cycles
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

  return { resolve, deepResolve };
}

// Find the "battle object" inside the array: the one that has keys like players/guilds/alliances/totalPlayers etc.
// We don't assume a fixed index; we search.
function findBattleRoot(arr) {
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    // The key set can vary slightly, so be flexible.
    const hasPlayersRef = Object.prototype.hasOwnProperty.call(item, "players");
    const hasGuildsRef = Object.prototype.hasOwnProperty.call(item, "guilds");
    const hasTotalPlayers = Object.prototype.hasOwnProperty.call(
      item,
      "totalPlayers",
    );

    // Also often has startedAt/finishedAt/totalFame/totalKills etc.
    if (hasPlayersRef && hasGuildsRef && hasTotalPlayers) {
      return item;
    }
  }
  throw new Error("Could not locate battle root object in Nuxt data");
}

function extractGuildPlayersFromNuxtArray(arr, guildName) {
  const { deepResolve } = makeResolver(arr);
  const battleRoot = findBattleRoot(arr);

  // battleRoot.players is an index pointing to an array of indices
  // battleRoot.guilds is an index pointing to an array of indices
  const playersListResolved = deepResolve(battleRoot.players);
  if (!Array.isArray(playersListResolved)) {
    throw new Error("Nuxt battleRoot.players did not resolve to an array");
  }

  // Each element resolves to a player object like:
  // { name: "Deskra", guildName: "Romania Mare", ... }
  const target = norm(guildName);
  const names = [];

  for (const playerObj of playersListResolved) {
    const p = deepResolve(playerObj);

    // Sometimes p might not be an object after deepResolve depending on structure
    if (!p || typeof p !== "object") continue;

    const g = norm(p.guildName);
    if (g !== target) continue;

    const n = String(p.name || "").trim();
    if (n) names.push(n);
  }

  // unique
  return [...new Set(names)];
}

async function getGuildPlayersFromBattle(battleId, guildName) {
  const html = await fetchBattleHtml(battleId);
  const nuxtArr = extractNuxtDataJson(html);

  if (!Array.isArray(nuxtArr)) {
    throw new Error(
      "__NUXT_DATA__ did not parse into an array (unexpected format)",
    );
  }

  const players = extractGuildPlayersFromNuxtArray(nuxtArr, guildName);
  return players;
}

module.exports = {
  extractBattleId,
  getGuildPlayersFromBattle,
};
