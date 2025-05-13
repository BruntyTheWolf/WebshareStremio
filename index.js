const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axiosBase = require("axios");
const crypto = require("crypto");
const xml2js = require("xml2js");

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
  version: "1.0.2",
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
const WS_USER = process.env.WS_USER || "luciehormandlova";
const WS_PASS = process.env.WS_PASS || "castren1990";
const TMDB_KEY = process.env.TMDB_KEY || "7fdf98a51f538346596a513b967b058b";

let WS_TOKEN = null;
const xmlParser = new xml2js.Parser({
  explicitArray: false,
  explicitRoot: false,
});

// Login
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

// TMDb titles
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
    { params: { api_key: TMDB_KEY }, responseType: "json" }
  );
  alt.data.titles.forEach((t) => {
    if (["CZ", "US"].includes(t.iso_3166_1)) titles.add(t.title);
  });
  return { titles: [...titles], year: movie.release_date?.split("-")[0] || "" };
}

// Variants
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

// Search
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
      let files = Array.isArray(xml.file) ? xml.file : [xml.file];
      console.log(`[Webshare] Got ${files.length} files for '${v}'`);
      const seen = new Set();
      const unique = files.filter((f) => {
        if (seen.has(f.ident)) return false;
        seen.add(f.ident);
        return true;
      });
      return unique.map((f) => ({
        title: `${f.name} (${(+f.size / 1024 / 1024 / 1024).toFixed(2)} GB)`,
        url: `${BASE}/file/${f.ident}/download`,
        behaviorHints: { notWebReady: false },
      }));
    }
  }
  return [];
}

// Main getStream
async function getStreamUrl(imdbId) {
  if (!WS_TOKEN) await login();
  const { titles, year } = await getTitlesFromImdb(imdbId);
  for (const t of titles) {
    const variants = generateSearchVariants(t, year);
    for (const sort of ["rating", "time_created", "size"]) {
      const streams = await trySearchVariants(variants, sort);
      if (streams.length) return streams;
    }
  }
  return [];
}

// Handler
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stremio] Stream request type=${type}, id=${id}`);
  const streams = await getStreamUrl(id);
  console.log(`[Stremio] Returning ${streams.length}`);
  return { streams };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
