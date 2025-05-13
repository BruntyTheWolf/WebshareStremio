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

let WS_TOKEN = null;

async function login() {
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
  } catch (err) {
    console.error("Login error:", err.response?.data || err.message);
  }
}

async function getStreamUrl(imdbId) {
  if (!WS_TOKEN) await login();
  try {
    const searchRes = await axios.post(API + "search/", {
      what: imdbId,
      wst: WS_TOKEN,
      category: "video",
      sort: "rating",
      limit: 10,
      offset: 0,
    });

    const files = searchRes.data.file || [];
    const streams = files.map((file) => {
      return {
        title: `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
        url: `${BASE}/file/${file.ident}/download`,
        behaviorHints: { notWebReady: false },
      };
    });

    return streams;
  } catch (err) {
    console.error("Stream fetch error:", err.response?.data || err.message);
    return [];
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  const streams = await getStreamUrl(id);
  return { streams };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
