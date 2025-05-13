// stremio-webshare-addon/index.js
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const crypto = require("crypto");

const manifest = {
  id: "community.webshare",
  version: "1.0.0",
  name: "Webshare CZ",
  description: "Streamování z Webshare přes Stremio",
  catalogs: [],
  resources: ["stream"],
  types: ["movie"],
  idPrefixes: ["tt"],
};

const builder = new addonBuilder(manifest);

const BASE = "https://webshare.cz";
const API = BASE + "/api/";

const WS_USER = process.env.WS_USER || "luciehormandlova";
const WS_PASS = process.env.WS_PASS || "castren1990";
const TMDB_KEY = process.env.TMDB_KEY || "7fdf98a51f538346596a513b967b058b";

let WS_TOKEN = null;

async function login() {
  console.log("[Login] Logging in to Webshare...");
  try {
    const saltRes = await axios.post(API + "salt/", {
      username_or_email: WS_USER,
    });
    const salt = saltRes.data.salt;

    const md5crypt = (pass, salt) => {
      return crypto
        .createHash("md5")
        .update(pass + salt)
        .digest("hex");
    };

    const encryptedPass = crypto
      .createHash("sha1")
      .update(md5crypt(WS_PASS, salt))
      .digest("hex");
    const digest = crypto
      .createHash("md5")
      .update(Buffer.from(`${WS_USER}:Webshare:${encryptedPass}`))
      .digest("hex");

    const loginRes = await axios.post(API + "login/", {
      username_or_email: WS_USER,
      password: encryptedPass,
      digest: digest,
      keep_logged_in: 1,
    });

    WS_TOKEN = loginRes.data.token;
    console.log("[Login] Webshare login successful.");
  } catch (err) {
    console.error("[Login] Login error:", err.response?.data || err.message);
  }
}

async function getTitlesFromImdb(imdbId) {
  console.log(`[TMDb] Looking up titles for IMDb ID: ${imdbId}`);
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: {
        api_key: TMDB_KEY,
        external_source: "imdb_id",
      },
    });

    const movie = res.data.movie_results?.[0];
    if (!movie) {
      console.warn("[TMDb] No movie found for IMDb ID:", imdbId);
      return [];
    }

    const titles = new Set();
    if (movie.title) titles.add(movie.title);
    if (movie.original_title) titles.add(movie.original_title);

    const altRes = await axios.get(
      `https://api.themoviedb.org/3/movie/${movie.id}/alternative_titles`,
      {
        params: { api_key: TMDB_KEY },
      }
    );

    const altTitles = altRes.data.titles || [];
    altTitles.forEach((t) => {
      if (["CZ", "US"].includes(t.iso_3166_1) && t.title) {
        titles.add(t.title);
      }
    });

    const filtered = Array.from(titles);
    console.log(`[TMDb] Filtered titles (EN/CZ only): ${filtered.join(", ")}`);
    return filtered;
  } catch (err) {
    console.error(
      "[TMDb] Error fetching titles:",
      err.response?.data || err.message
    );
    return [];
  }
}

async function getStreamUrl(imdbId) {
  if (!WS_TOKEN) await login();

  const titles = await getTitlesFromImdb(imdbId);
  if (!titles.length) {
    console.warn("[Webshare] No titles to search for IMDb ID:", imdbId);
    return [];
  }

  for (const title of titles) {
    console.log(`[Webshare] Searching for title: ${title}`);
    try {
      const searchRes = await axios.post(API + "search/", {
        what: title,
        wst: WS_TOKEN,
        category: "video",
        sort: "rating",
        maybe_removed: "true",
        lang: "",
        limit: 50,
        offset: 0,
      });

      const files = searchRes.data.file || [];
      if (files.length) {
        console.log(`[Webshare] Found ${files.length} results for "${title}"`);
        const streams = files.map((file) => ({
          title: `${file.name} (${(file.size / 1024 / 1024 / 1024).toFixed(
            2
          )} GB)`,
          url: `${BASE}/file/${file.ident}/download`,
          behaviorHints: { notWebReady: false },
        }));

        return streams;
      }
    } catch (err) {
      console.error(
        `[Webshare] Error searching for title "${title}":`,
        err.response?.data || err.message
      );
    }
  }

  console.warn("[Webshare] No results found for any title.");
  return [];
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stremio] Incoming stream request: type=${type}, id=${id}`);
  const streams = await getStreamUrl(id);
  console.log(`[Stremio] Returning ${streams.length} stream(s)`);
  return { streams };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
