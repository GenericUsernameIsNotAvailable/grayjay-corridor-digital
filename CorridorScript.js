const PLATFORM = "Corridor Digital";
const CACHE_HOST = "https://content-cache.corridordigital.com";
const CONTENT_HOST = "https://content.corridordigital.com";
const WEB_HOST = "https://www.corridordigital.com";

const DEFAULT_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.corridordigital.com",
  "Referer": "https://www.corridordigital.com/",
  "x-platform": "web"
};

let config = {};

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

function pickBestImage(images) {
  if (!Array.isArray(images) || images.length === 0) return "";
  const preferred = images.find(img =>
    img && img.url && /thumb|landscape|wide|16x9|poster|banner/i.test(img.type || "")
  );
  if (preferred && preferred.url) return preferred.url;

  const sorted = images
    .filter(img => img && typeof img.url === "string" && img.url.length > 0)
    .slice()
    .sort((a, b) => (b.width || 0) - (a.width || 0));

  return sorted.length > 0 ? sorted[0].url : "";
}

function buildThumbnails(images, fallbackUrl) {
  const list = [];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img && typeof img.url === "string" && img.url.length > 0) {
        list.push(new Thumbnail(img.url, img.width || 0));
      }
    }
  }
  if (list.length === 0 && fallbackUrl) {
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

function isPublicItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.subscriptionOnly === true) return false;
  if (item.exclusive === true) return false;
  return true;
}

function getSeasonUrl(seasonId) {
  return `${WEB_HOST}/season/${seasonId}`;
}

function getWatchUrl(videoId) {
  return `${WEB_HOST}/watch/${videoId}`;
}

function mapSeasonToChannel(item) {
  const seasonId = item.seasonId || item.id;
  const thumb = pickBestImage(item.images);
  return new PlatformChannel({
    id: new PlatformID(PLATFORM, `season-${seasonId}`, config.id),
    name: item.title || item.name || `Show ${seasonId}`,
    thumbnail: thumb,
    banner: thumb,
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

  return new PlatformVideo({
    id: new PlatformID(PLATFORM, String(videoId), config.id),
    name: ep.title || `Episode ${videoId}`,
    thumbnails: buildThumbnails(ep.images, seasonThumb),
    author: new PlatformAuthorLink(
      new PlatformID(PLATFORM, authorId, config.id),
      authorName,
      authorUrl,
      seasonThumb || ""
    ),
    uploadDate: parseUnixDate(ep.datePublished),
    duration: parseDurationSeconds(ep.duration),
    viewCount: 0,
    url: getWatchUrl(videoId),
    isLive: false
  });
}

function collectPublicShows() {
  const showsPage = fetchJson(`${CACHE_HOST}/pages/v1/shows?pageRowSize=20`);
  const rows = Array.isArray(showsPage.pageRows) ? showsPage.pageRows : [];
  const seenSeasons = new Map();

  for (const row of rows) {
    if (row.exclusive === true) continue;

    const initialMedia = Array.isArray(row.media) ? row.media : [];
    for (const item of initialMedia) {
      const sId = item.seasonId || item.id;
      if (sId && isPublicItem(item) && !seenSeasons.has(sId)) {
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
          if (sId && isPublicItem(item) && !seenSeasons.has(sId)) {
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
// Home Feed (Public Episodes from Public Shows)
// ---------------------------------------------------------------------------

source.getHome = function (continuationToken) {
  const shows = collectPublicShows();
  const pageIndex = continuationToken && typeof continuationToken.index === "number"
    ? continuationToken.index
    : 0;

  const batchSize = 3;
  const slice = shows.slice(pageIndex, pageIndex + batchSize);
  const videos = [];

  for (const show of slice) {
    const seasonId = show.seasonId || show.id;
    try {
      const seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${seasonId}`);
      if (seasonData.exclusive === true) continue;
      const seasonName = seasonData.name || show.title || "Corridor Digital";
      const seasonThumb = pickBestImage(seasonData.images) || pickBestImage(show.images);
      const episodes = Array.isArray(seasonData.media) ? seasonData.media : [];

      for (const ep of episodes) {
        if (!isPublicItem(ep)) continue;
        ep.seasonId = seasonId;
        videos.push(mapEpisodeToVideo(ep, seasonName, seasonThumb));
      }
    } catch (e) {
      // Skip seasons that fail to load
    }
  }

  const nextIndex = pageIndex + batchSize;
  const hasMore = nextIndex < shows.length;
  return new VideoPager(videos, hasMore, hasMore ? { index: nextIndex } : null);
};

// ---------------------------------------------------------------------------
// Search (Shows & Episodes)
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

  const shows = collectPublicShows();
  const results = [];
  const seenVideoIds = new Set();

  for (const show of shows) {
    const seasonId = show.seasonId || show.id;
    let seasonData;
    try {
      seasonData = fetchJson(`${CACHE_HOST}/channels/v16/season/${seasonId}`);
    } catch (e) {
      continue;
    }
    if (seasonData.exclusive === true) continue;

    const seasonName = seasonData.name || show.title || "";
    const seasonThumb = pickBestImage(seasonData.images) || pickBestImage(show.images);
    const showMatches =
      seasonName.toLowerCase().includes(q) ||
      (show.shortDescription || "").toLowerCase().includes(q);

    const episodes = Array.isArray(seasonData.media) ? seasonData.media : [];
    for (const ep of episodes) {
      if (!isPublicItem(ep)) continue;
      const vid = ep.id || ep.mediaId;
      if (!vid || seenVideoIds.has(vid)) continue;

      const epTitle = (ep.title || "").toLowerCase();
      const epDesc = (ep.shortDescription || "").toLowerCase();

      if (showMatches || epTitle.includes(q) || epDesc.includes(q)) {
        seenVideoIds.add(vid);
        ep.seasonId = seasonId;
        results.push(mapEpisodeToVideo(ep, seasonName, seasonThumb));
      }
    }
  }

  return new VideoPager(results, false);
};

source.searchChannels = function (query, continuationToken) {
  const q = (query || "").trim().toLowerCase();
  const shows = collectPublicShows();
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
// Shows / Seasons as Channels
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

  if (seasonData.exclusive === true) {
    throw new ScriptException("UNSUPPORTED", "This show is marked as exclusive.");
  }

  const thumb = pickBestImage(seasonData.images);
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
    banner: thumb,
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

  if (seasonData.exclusive === true) {
    return new VideoPager([], false);
  }

  const seasonName = seasonData.name || `Season ${seasonId}`;
  const seasonThumb = pickBestImage(seasonData.images);
  const episodes = Array.isArray(seasonData.media) ? seasonData.media : [];

  const videos = [];
  const seenIds = new Set();

  for (const ep of episodes) {
    if (!isPublicItem(ep)) continue;
    const vid = ep.id || ep.mediaId;
    if (!vid || seenIds.has(vid)) continue;
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
      if (sibData.exclusive === true) continue;
      const sibName = sibData.name || sib.name || seasonName;
      const sibThumb = pickBestImage(sibData.images) || seasonThumb;
      const sibEps = Array.isArray(sibData.media) ? sibData.media : [];

      for (const ep of sibEps) {
        if (!isPublicItem(ep)) continue;
        const vid = ep.id || ep.mediaId;
        if (!vid || seenIds.has(vid)) continue;
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
// Video Details & Free DASH Playback
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
      seasonThumb = pickBestImage(seasonData.images);
      const mediaList = Array.isArray(seasonData.media) ? seasonData.media : [];
      seasonEp = mediaList.find(m =>
        String(m.id) === String(videoId) || String(m.mediaId) === String(videoId)
      ) || null;
    } catch (e) {
      // Proceed with metadata alone
    }
  }

  if (seasonEp && !isPublicItem(seasonEp)) {
    throw new ScriptException("UNSUPPORTED", "This episode requires a Corridor Digital subscription.");
  }

  const durationSec = seasonEp ? parseDurationSeconds(seasonEp.duration) : 0;
  const title = meta.title || (seasonEp && seasonEp.title) || `Episode ${videoId}`;
  let description = meta.description || meta.shortDescription || (seasonEp && seasonEp.shortDescription) || "";
  const uploadDate = parseUnixDate(meta.datePublished || (seasonEp && seasonEp.datePublished));
  let posterFallback = seasonThumb;

  // 3. Attempt to resolve unencrypted free DASH playback
  let dashSource = null;
  const playResp = http.GET(`${CONTENT_HOST}/v5/video/${videoId}/free?platform=Web`, DEFAULT_HEADERS);

  if (playResp.isOk) {
    try {
      const playData = JSON.parse(playResp.body);
      if (playData.poster) {
        posterFallback = playData.poster;
      }
      if (playData.dashUrl) {
        const mpdResp = http.GET(playData.dashUrl, {
          "Origin": "https://www.corridordigital.com",
          "Referer": "https://www.corridordigital.com/"
        });
        if (mpdResp.isOk) {
          const mpdXml = mpdResp.body || "";
          const isDrmProtected =
            /<ContentProtection/i.test(mpdXml) ||
            /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(mpdXml) ||
            /cenc/i.test(mpdXml);

          if (!isDrmProtected) {
            dashSource = new DashSource({
              name: "DASH (Auto)",
              duration: durationSec,
              url: playData.dashUrl
            });
          } else {
            description = `[Playback unavailable: stream is Widevine DRM-protected]\n\n${description}`;
          }
        }
      }
    } catch (e) {
      // Preserve metadata even if playback manifest parsing fails
    }
  }

  const thumbnails = buildThumbnails(metaImages, posterFallback);
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
    video: new UnMuxVideoSourceDescriptor([], []),
    dash: dashSource
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