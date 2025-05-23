const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axiosBase = require("axios");
const crypto = require("crypto");
const xml2js = require("xml2js");
const { v4: uuidv4 } = require("uuid");

// HTTP client
const axios = axiosBase.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/81.0.4044.138 Safari/537.36",
    Referer: "https://webshare.cz",
  },
  withCredentials: true,
  responseType: "text",
});

// Helper to send form data
function postForm(url, data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null)
      params.append(key, String(value));
  }
  return axios.post(url, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

// Manifest
const manifest = {
  id: "community.webshare",
  version: "1.0.6",
  name: "Webshare CZ",
  description: "Streamování z Webshare přes Stremio",
  catalogs: [],
  resources: ["stream"],
  types: ["movie"],
  idPrefixes: ["tt"],
};
const builder = new addonBuilder(manifest);

// Config
const BASE = "https://webshare.cz";
const API = BASE + "/api/";
const WS_USER = process.env.WS_USER || "USER";
const WS_PASS = process.env.WS_PASS || "PASSWORD";
const TMDB_KEY = process.env.TMDB_KEY || "TOKEN";

let WS_TOKEN = null;
const DEVICE_UUID = uuidv4();
const xmlParser = new xml2js.Parser({
  explicitArray: false,
  explicitRoot: false,
});

// Login implementation
async function login() {
  console.log("[Login] Logging in to Webshare...");
  const saltRes = await postForm(API + "salt/", { username_or_email: WS_USER });
  const { salt } = await xmlParser.parseStringPromise(saltRes.data);
  const md5crypt = (p, s) =>
    crypto
      .createHash("md5")
      .update(p + s)
      .digest("hex");
  const encrypted = crypto
    .createHash("sha1")
    .update(md5crypt(WS_PASS, salt))
    .digest("hex");
  const digest = crypto
    .createHash("md5")
    .update(Buffer.from(`${WS_USER}:Webshare:${encrypted}`))
    .digest("hex");
  const loginRes = await postForm(API + "login/", {
    username_or_email: WS_USER,
    password: encrypted,
    digest,
    keep_logged_in: 1,
  });
  const { token } = await xmlParser.parseStringPromise(loginRes.data);
  WS_TOKEN = token;
  console.log("[Login] Successful, token set.");
}

// Get file stream URL
async function getLink(ident, dtype = "video_stream") {
  const res = await postForm(API + "file_link/", {
    ident,
    wst: WS_TOKEN,
    download_type: dtype,
    device_uuid: DEVICE_UUID,
  });
  const xml = await xmlParser.parseStringPromise(res.data);
  if (xml.status === "OK" && xml.link) {
    return xml.link;
  }
  console.error("[getLink] failed for", ident);
  return null;
}

// TMDb metadata
async function getTitlesFromImdb(imdbId) {
  const res = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
    params: { api_key: TMDB_KEY, external_source: "imdb_id" },
    responseType: "json",
  });
  const movie = res.data.movie_results?.[0];
  if (!movie) return { titles: [], year: "" };
  const titles = new Set([movie.title, movie.original_title]);
  const alt = await axios.get(
    `https://api.themoviedb.org/3/movie/${movie.id}/alternative_titles`,
    {
      params: { api_key: TMDB_KEY },
      responseType: "json",
    }
  );
  alt.data.titles.forEach((t) => {
    if (["CZ", "US"].includes(t.iso_3166_1) && t.title) titles.add(t.title);
  });
  return { titles: [...titles], year: movie.release_date?.split("-")[0] || "" };
}

// Generate search strings
function generateSearchVariants(title, year) {
  const norm = title.normalize("NFD").replace(/\p{M}/gu, "");
  const base = norm.replace(/[^\w ]/g, "").trim();
  const compact = base.replace(/\s+/g, "");
  return [
    ...new Set([
      base,
      base + ` ${year}`,
      compact,
      compact + year,
      `${compact}.${year}`,
      compact + ".mp4",
      compact + ".mkv",
      compact + ".avi",
    ]),
  ];
}

// Search Webshare
async function trySearchVariants(variants, sort) {
  for (const v of variants) {
    console.log(`[Webshare] Searching: '${v}' sort=${sort}`);
    const res = await postForm(API + "search/", {
      what: v,
      wst: WS_TOKEN,
      category: "video",
      sort,
      maybe_removed: "true",
      lang: "",
      limit: 50,
      offset: 0,
    });
    const xml = await xmlParser.parseStringPromise(res.data);
    if (xml.status === "OK" && xml.file) {
      const files = Array.isArray(xml.file) ? xml.file : [xml.file];
      console.log(`[Webshare] Got ${files.length} files for '${v}'`);
      const seen = new Set();
      return files
        .filter((f) => !seen.has(f.ident) && seen.add(f.ident))
        .map((f) => ({
          ident: f.ident,
          title: `${f.name} (${(+f.size / 1024 / 1024 / 1024).toFixed(2)} GB)`,
          behaviorHints: { notWebReady: false },
        }));
    }
  }
  return [];
}

// Main stream retrieval
async function getStreamItems(imdbId) {
  const { titles, year } = await getTitlesFromImdb(imdbId);
  for (const t of titles) {
    const variants = generateSearchVariants(t, year);
    for (const sort of ["rating", "time_created", "size"]) {
      const items = await trySearchVariants(variants, sort);
      if (items.length) return items;
    }
  }
  return [];
}

// Stream handler
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stremio] Stream request type=${type}, id=${id}`);
  if (!WS_TOKEN) await login(); // ensure single login per session
  const items = await getStreamItems(id);
  const streams = [];
  for (const it of items) {
    const link = await getLink(it.ident);
    if (link) {
      streams.push({
        title: it.title,
        url: link,
        headers: { Cookie: `wst=${WS_TOKEN}` },
        behaviorHints: { notWebReady: false },
      });
    }
  }
  console.log(`[Stremio] Returning ${streams.length} stream(s)`);
  return { streams };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
builder.getInterface(), { port: process.env.PORT || 7000 };
