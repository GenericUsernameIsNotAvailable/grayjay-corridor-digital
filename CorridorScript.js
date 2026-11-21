const PLATFORM = "Corridor Digital";
const CACHE_HOST = "https://content-cache.corridordigital.com";
const CONTENT_HOST = "https://content.corridordigital.com";
const WEB_HOST = "https://www.corridordigital.com";
const DEFAULT_FREE_ROW_ID = 7;

const DEFAULT_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.corridordigital.com",
  "Referer": "https://www.corridordigital.com/",
  "x-platform": "web"
};

let config = {};
let cachedFreeRowId = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

source.enable = function (conf) {
  config = conf || {};
};

source.saveState = function () {
  return JSON.stringify({});
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchJson(url) {
  const resp = http.GET(url, DEFAULT_HEADERS);
  if (!resp.isOk) {
    throw new ScriptException("HTTP_ERROR", `Request failed (${resp.code}) for ${url}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new ScriptException("PARSE_ERROR", `Invalid JSON from ${url}`);
  }
}

function getFreeRowId() {
  if (cachedFreeRowId !== null) return cachedFreeRowId;
  try {
    const home = fetchJson(`${CACHE_HOST}/pages/v1/home?pageRowSize=1`);
    const rows = Array.isArray(home.pageRows) ? home.pageRows : [];
    const freeRow = rows.find(r => r && r.type === "free-media-list" && r.id);
    cachedFreeRowId = freeRow ? freeRow.id : DEFAULT_FREE_ROW_ID;
  } catch (e) {
    cachedFreeRowId = DEFAULT_FREE_ROW_ID;
  }
  return cachedFreeRowId;
}

function isAnimatedPreview(img) {
  if (!img || typeof img.url !== "string" || !img.url.length) return true;
  const type = (img.type || "").toLowerCase();
  const url = img.url.toLowerCase();

  if (type === "media-preview") return true;
  if (/preview|anim|hover|motion|gif/i.test(type)) return true;
  if (/\.gif(\?|$)/i.test(url)) return true;
  if (/[?&]a=true/i.test(url) || /\/previews?\//i.test(url)) return true;

  return false;
}

function pickStaticImage(images, preferredTypes) {
  if (!Array.isArray(images) || images.length === 0) return "";
  const staticImgs = images.filter(img => !isAnimatedPreview(img));
  if (staticImgs.length === 0) return "";

  const order = preferredTypes || ["thumbnail", "hero-web", "packshot", "hero-mobile"];
  for (const t of order) {
    const match = staticImgs.find(img => (img.type || "").toLowerCase() === t);
    if (match && match.url) return match.url;
  }

  const sorted = staticImgs.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0].url;
}

function buildStaticThumbnails(images, fallbackUrl) {
  const list = [];

  if (Array.isArray(images) && images.length > 0) {
    const staticImgs = images.filter(img => !isAnimatedPreview(img));
    const exactThumb = staticImgs.find(img => (img.type || "").toLowerCase() === "thumbnail");

    if (exactThumb) {
      list.push(new Thumbnail(exactThumb.url, exactThumb.width || 720));
    } else if (staticImgs.length > 0) {
      const hasTyped = staticImgs.some(img => typeof img.type === "string" && img.type.length > 0);
      if (hasTyped) {
        const best = pickStaticImage(staticImgs, ["thumbnail", "hero-web", "packshot", "hero-mobile"]);
        if (best) list.push(new Thumbnail(best, 720));
      } else {
        for (const img of staticImgs) {
          list.push(new Thumbnail(img.url, img.width || 0));
        }
      }
    }
  }

  if (list.length === 0 && fallbackUrl && !isAnimatedPreview({ url: fallbackUrl })) {
    list.push(new Thumbnail(fallbackUrl, 0));
  }

  return new Thumbnails(list);
}

function parseDurationSeconds(raw) {
  if (typeof raw === "number" && !isNaN(raw)) return Math.floor(raw);
  if (typeof raw !== "string" || !raw.trim()) return 0;

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const parts = trimmed.split(":").map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

function parseUnixDate(dateStr) {
  if (!dateStr) return 0;
  const ms = Date.parse(dateStr);
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function getSeasonUrl(seasonId) {
  return `${WEB_HOST}/season/${seasonId}`;
}

function getWatchUrl(videoId) {
  return `${WEB_HOST}/watch/${videoId}`;
}

function mapSeasonToChannel(item) {
  const seasonId = item.seasonId || item.id;
  const thumb = pickStaticImage(item.images, ["thumbnail", "packshot", "hero-web"]);
  const banner = pickStaticImage(item.images, ["hero-web", "thumbnail", "packshot"]);
  return new PlatformChannel({
    id: new PlatformID(PLATFORM, `season-${seasonId}`, config.id),
    name: item.title || item.name || `Show ${seasonId}`,
    thumbnail: thumb,
    banner: banner || thumb,
    subscribers: 0,
    description: item.shortDescription || "",
    url: getSeasonUrl(seasonId),
    links: {}
  });
}

function mapEpisodeToVideo(ep, seasonName, seasonThumb) {
  const videoId = ep.id || ep.mediaId;
  const seasonId = ep.seasonId || "";
  const authorName = seasonName || "Corridor Digital";
  const authorUrl = seasonId ? getSeasonUrl(seasonId) : WEB_HOST;
  const authorId = seasonId ? `season-${seasonId}` : "corridor-digital";
  const badgeThumb = pickStaticImage(ep.images, ["channel-badge"]) || seasonThumb || "";

  return new PlatformVideo({
    id: new PlatformID(PLATFORM, String(videoId), config.id),
    name: ep.title || `Episode ${videoId}`,
    thumbnails: buildStaticThumbnails(ep.images, seasonThumb),
    author: new PlatformAuthorLink(
      new PlatformID(PLATFORM, authorId, config.id),
      authorName,
      authorUrl,
      badgeThumb
    ),
    uploadDate: parseUnixDate(ep.datePublished),
    duration: parseDurationSeconds(ep.duration),
    viewCount: 0,
    url: getWatchUrl(videoId),
    isLive: false
  });
}

function fetchAllFreeVideos() {
  const rowId = getFreeRowId();
  const all = [];
  const seen = new Set();

  for (let page = 1; page <= 20; page++) {
    let items;
    try {
      items = fetchJson(`${CACHE_HOST}/pages/v1/row/${rowId}?count=20&page=${page}`);
    } catch (e) {
      break;
    }
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const vid = String(item.id || item.mediaId || "");
      if (vid && !seen.has(vid)) {
        seen.add(vid);
        all.push(item);
      }
    }
    if (items.length < 20) break;
  }

  return all;
}

function collectShows() {
  const showsPage = fetchJson(`${CACHE_HOST}/pages/v1/shows?pageRowSize=20`);
  const rows = Array.isArray(showsPage.pageRows) ? showsPage.pageRows : [];
  const seenSeasons = new Map();

  for (const row of rows) {
    const initialMedia = Array.isArray(row.media) ? row.media : [];
    for (const item of initialMedia) {
      const sId = item.seasonId || item.id;
      if (sId && !seenSeasons.has(sId)) {
        seenSeasons.set(sId, item);
      }
    }

    if (row.id && initialMedia.length >= 20) {
      for (let page = 2; page <= 10; page++) {
        let extra;
        try {
          extra = fetchJson(`${CACHE_HOST}/pages/v1/row/${row.id}?count=20&page=${page}`);
        } catch (e) {
          break;
        }
        if (!Array.isArray(extra) || extra.length === 0) break;
        for (const item of extra) {
          const sId = item.seasonId || item.id;
          if (sId && !seenSeasons.has(sId)) {
            seenSeasons.set(sId, item);
          }
        }
        if (extra.length < 20) break;
      }
    }
  }

  return Array.from(seenSeasons.values());
}

// ---------------------------------------------------------------------------
// Home Feed (Properly paginated Free to Watch catalogue)
// ---------------------------------------------------------------------------

class CorridorFreePager extends VideoPager {
  constructor(results, hasMore, nextPageNum) {
    super(results, hasMore, { page: nextPageNum });
    this.nextPageNum = nextPageNum;
  }

  nextPage() {
    if (!this.hasMore) {
      return new CorridorFreePager([], false, this.nextPageNum);
    }
    return fetchFreeHomePage(this.nextPageNum);
  }
}

function fetchFreeHomePage(page) {
  const rowId = getFreeRowId();
  const pageSize = 20;
  const items = fetchJson(`${CACHE_HOST}/pages/v1/row/${rowId}?count=${pageSize}&page=${page}`);
  const list = Array.isArray(items) ? items : [];
  const videos = [];

  for (const ep of list) {
    const vid = ep.id || ep.mediaId;
    if (!vid) continue;
    videos.push(mapEpisodeToVideo(ep, "Corridor Digital", ""));
  }

  const hasMore = list.length >= pageSize;
  return new CorridorFreePager(videos, hasMore, page + 1);
}

source.getHome = function (continuationToken) {
  const page = continuationToken && typeof continuationToken.page === "number"
    ? continuationToken.page
    : 1;
  return fetchFreeHomePage(page);
};

// ---------------------------------------------------------------------------
// Search (Free videos + show-name matching intersected with Free list)
// ---------------------------------------------------------------------------

source.getSearchCapabilities = function () {
  return {
    types: [Type.Feed.Mixed, Type.Feed.Videos],
    sorts: [Type.Order.Chronological],
    filters: []
  };
};

source.searchSuggestions = function (query) {
  return [];
};

source.search = function (query, type, order, filters, continuationToken) {
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    return new VideoPager([], false);
  }

  const freeVideos = fetchAllFreeVideos();
  const freeMap = new Map();
  for (const ep of freeVideos) {
    const vid = String(ep.id || ep.mediaId || "");
    if (vid) freeMap.set(vid, ep);
  }

  const results = [];
  const seenIds = new Set();

  // 1. Direct match on free video title/description
  for (const ep of freeVideos) {
    const vid = String(ep.id || ep.mediaId || "");
    const title = (ep.title || "").toLowerCase();
    const desc = (ep.shortDescription || "").toLowerCase();
    if (title.includes(q) || desc.includes(q)) {
      seenIds.add(vid);
      results.push(mapEpisodeToVideo(ep, "Corridor Digital", ""));
    }
  }

  // 2. Match show/season names (e.g. "Son of a Dungeon") and include their free episodes
  try {
    const shows = collectShows();
    const matchedShows = shows.filter(s =>
      (s.title || s.name || "").toLowerCase().includes(q) ||
      (s.shortDescription || "").toLowerCase().includes(q)
    );

    const visitedSeasons = new Set();
    for (const show of matchedShows) {
      const seasonId = show.seasonId || show.id;
      if (!seasonId || visitedSeasons.has(String(seasonId))) continue;
      visitedSeasons.add(String(seasonId));

      let seasonData;
      try {
        seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${seasonId}`);
      } catch (e) {
        continue;
      }

      const seasonQueue = [seasonData];
      const siblings = seasonData.series && Array.isArray(seasonData.series.seasons)
        ? seasonData.series.seasons
        : [];

      for (const sib of siblings) {
        if (!sib.seasonId || visitedSeasons.has(String(sib.seasonId))) continue;
        visitedSeasons.add(String(sib.seasonId));
        try {
          seasonQueue.push(fetchJson(`${CACHE_HOST}/channels/v16/season/${sib.seasonId}`));
        } catch (e) {
          // Skip failed sibling season
        }
      }

      for (const sd of seasonQueue) {
        const sName = sd.name || show.title || "Corridor Digital";
        const sThumb = pickStaticImage(sd.images) || pickStaticImage(show.images);
        const eps = Array.isArray(sd.media) ? sd.media : [];
        for (const ep of eps) {
          const vid = String(ep.id || ep.mediaId || "");
          if (!vid || seenIds.has(vid) || !freeMap.has(vid)) continue;
          seenIds.add(vid);
          ep.seasonId = sd.id || seasonId;
          results.push(mapEpisodeToVideo(ep, sName, sThumb));
        }
      }
    }
  } catch (e) {
    // Keep direct matches even if show lookup fails
  }

  return new VideoPager(results, false);
};

source.searchChannels = function (query, continuationToken) {
  const q = (query || "").trim().toLowerCase();
  const shows = collectShows();
  const matched = shows
    .filter(s =>
      !q ||
      (s.title || s.name || "").toLowerCase().includes(q) ||
      (s.shortDescription || "").toLowerCase().includes(q)
    )
    .map(mapSeasonToChannel);

  return new ChannelPager(matched, false);
};

// ---------------------------------------------------------------------------
// Shows / Seasons as Channels (Filtered to playable free episodes)
// ---------------------------------------------------------------------------

source.isChannelUrl = function (url) {
  return /^https?:\/\/(www\.)?corridordigital\.com\/(season|show)\/\d+/i.test(url);
};

source.getChannel = function (url) {
  const match = url.match(/\/(season|show)\/(\d+)/i);
  if (!match) {
    throw new ScriptException("INVALID_URL", `Unsupported show/season URL: ${url}`);
  }
  const seasonId = match[2];
  const seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${seasonId}`);

  const thumb = pickStaticImage(seasonData.images, ["thumbnail", "packshot", "hero-web"]);
  const banner = pickStaticImage(seasonData.images, ["hero-web", "thumbnail", "packshot"]);
  const seasonList = seasonData.series && Array.isArray(seasonData.series.seasons)
    ? seasonData.series.seasons
    : [];

  const seasonSummary = seasonList.length > 0
    ? `Available seasons: ${seasonList.map(s => `${s.name} (${s.episodeCount} eps)`).join(", ")}`
    : "";

  return new PlatformChannel({
    id: new PlatformID(PLATFORM, `season-${seasonId}`, config.id),
    name: seasonData.name || `Season ${seasonId}`,
    thumbnail: thumb,
    banner: banner || thumb,
    subscribers: 0,
    description: seasonSummary,
    url: getSeasonUrl(seasonId),
    links: {}
  });
};

source.getChannelContents = function (url, type, order, filters, continuationToken) {
  const match = url.match(/\/(season|show)\/(\d+)/i);
  if (!match) {
    return new VideoPager([], false);
  }
  const seasonId = match[2];
  const seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${seasonId}`);

  const freeVideos = fetchAllFreeVideos();
  const freeIds = new Set(freeVideos.map(v => String(v.id || v.mediaId || "")));

  const seasonName = seasonData.name || `Season ${seasonId}`;
  const seasonThumb = pickStaticImage(seasonData.images);
  const episodes = Array.isArray(seasonData.media) ? seasonData.media : [];

  const videos = [];
  const seenIds = new Set();

  for (const ep of episodes) {
    const vid = String(ep.id || ep.mediaId || "");
    if (!vid || seenIds.has(vid) || !freeIds.has(vid)) continue;
    seenIds.add(vid);
    ep.seasonId = seasonId;
    videos.push(mapEpisodeToVideo(ep, seasonName, seasonThumb));
  }

  const siblingSeasons = seasonData.series && Array.isArray(seasonData.series.seasons)
    ? seasonData.series.seasons
    : [];

  for (const sib of siblingSeasons) {
    if (!sib.seasonId || String(sib.seasonId) === String(seasonId)) continue;
    try {
      const sibData = fetchJson(`${CACHE_HOST}/channels/v16/season/${sib.seasonId}`);
      const sibName = sibData.name || sib.name || seasonName;
      const sibThumb = pickStaticImage(sibData.images) || seasonThumb;
      const sibEps = Array.isArray(sibData.media) ? sibData.media : [];

      for (const ep of sibEps) {
        const vid = String(ep.id || ep.mediaId || "");
        if (!vid || seenIds.has(vid) || !freeIds.has(vid)) continue;
        seenIds.add(vid);
        ep.seasonId = sib.seasonId;
        videos.push(mapEpisodeToVideo(ep, `${seasonName} - ${sibName}`, sibThumb));
      }
    } catch (e) {
      // Ignore sibling season fetch errors
    }
  }

  return new VideoPager(videos, false);
};

// ---------------------------------------------------------------------------
// Video Details & Free Playback
// ---------------------------------------------------------------------------

source.isContentDetailsUrl = function (url) {
  return /^https?:\/\/(www\.)?corridordigital\.com\/watch\/\d+/i.test(url);
};

source.getContentDetails = function (url) {
  const match = url.match(/\/watch\/(\d+)/i);
  if (!match) {
    throw new ScriptException("INVALID_URL", `Unsupported video URL: ${url}`);
  }
  const videoId = match[1];

  // 1. Fetch video metadata (/v3/metadata/{id})
  const metaWrapper = fetchJson(`${CACHE_HOST}/v3/metadata/${videoId}`);
  const meta = metaWrapper.metadata || {};
  const metaImages = Array.isArray(metaWrapper.images) ? metaWrapper.images : [];

  // 2. Enrich with season episode record if seasonId is present
  let seasonEp = null;
  let seasonName = "Corridor Digital";
  let seasonThumb = "";

  if (meta.seasonId) {
    try {
      const seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${meta.seasonId}`);
      seasonName = seasonData.name || seasonName;
      seasonThumb = pickStaticImage(seasonData.images);
      const mediaList = Array.isArray(seasonData.media) ? seasonData.media : [];
      seasonEp = mediaList.find(m =>
        String(m.id) === String(videoId) || String(m.mediaId) === String(videoId)
      ) || null;
    } catch (e) {
      // Proceed with metadata alone
    }
  }

  const durationSec = seasonEp ? parseDurationSeconds(seasonEp.duration) : 0;
  const title = meta.title || (seasonEp && seasonEp.title) || `Episode ${videoId}`;
  const description = meta.description || meta.shortDescription || (seasonEp && seasonEp.shortDescription) || "";
  const uploadDate = parseUnixDate(meta.datePublished || (seasonEp && seasonEp.datePublished));
  let posterFallback = seasonThumb;

  // 3. Request free playback endpoint (/v5/video/{id}/free?platform=Web)
  const playResp = http.GET(`${CONTENT_HOST}/v5/video/${videoId}/free?platform=Web`, DEFAULT_HEADERS);

  if (!playResp.isOk) {
    const bodyText = (playResp.body || "").trim();
    if (playResp.code === 400 || /not available under a free account/i.test(bodyText)) {
      throw new ScriptException(
        "UNAVAILABLE",
        "This episode requires a paid Corridor Digital subscription and is not available on the free tier."
      );
    }
    throw new ScriptException("HTTP_ERROR", `Free playback request failed (HTTP ${playResp.code}).`);
  }

  let playData;
  try {
    playData = JSON.parse(playResp.body);
  } catch (e) {
    throw new ScriptException("PARSE_ERROR", "Invalid playback response JSON.");
  }

  if (playData.poster) {
    posterFallback = playData.poster;
  }

  const videoSources = [];
  if (playData.dashUrl) {
    const mpdResp = http.GET(playData.dashUrl, {
      "Origin": "https://www.corridordigital.com",
      "Referer": "https://www.corridordigital.com/"
    });

    const mpdXml = mpdResp.isOk ? (mpdResp.body || "") : "";
    const isDrmProtected =
      /<ContentProtection/i.test(mpdXml) ||
      /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(mpdXml) ||
      /cenc/i.test(mpdXml);

    if (isDrmProtected && playData.widevineUrl && typeof DashWidevineSource === "function") {
      videoSources.push(new DashWidevineSource({
        name: "DASH (Widevine)",
        duration: durationSec,
        url: playData.dashUrl,
        licenseUri: playData.widevineUrl
      }));
    } else if (!isDrmProtected) {
      videoSources.push(new DashSource({
        name: "DASH (Auto)",
        duration: durationSec,
        url: playData.dashUrl
      }));
    } else {
      throw new ScriptException(
        "UNSUPPORTED",
        "This episode requires Widevine DRM, which is not supported by this version of Grayjay."
      );
    }
  }

  const thumbnails = buildStaticThumbnails(metaImages, posterFallback);
  const authorId = meta.seasonId ? `season-${meta.seasonId}` : "corridor-digital";
  const authorUrl = meta.seasonId ? getSeasonUrl(meta.seasonId) : WEB_HOST;

  return new PlatformVideoDetails({
    id: new PlatformID(PLATFORM, String(videoId), config.id),
    name: title,
    thumbnails: thumbnails,
    author: new PlatformAuthorLink(
      new PlatformID(PLATFORM, authorId, config.id),
      seasonName,
      authorUrl,
      seasonThumb
    ),
    uploadDate: uploadDate,
    duration: durationSec,
    viewCount: 0,
    url: getWatchUrl(videoId),
    isLive: false,
    description: description,
    video: new VideoSourceDescriptor(videoSources)
  });
};

// ---------------------------------------------------------------------------
// Comments (Not applicable / public-only scope)
// ---------------------------------------------------------------------------

source.getComments = function (url, continuationToken) {
  return new CommentPager([], false);
};

source.getSubComments = function (comment) {
  return new CommentPager([], false);
};