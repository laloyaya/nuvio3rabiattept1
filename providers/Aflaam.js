// Aflaam provider for Nuvio, ported from the CloudStream plugin (Abodabodd/re-3arabi).
// Promise chains are used on purpose (Hermes compatibility).
// No API key needed: titles are read from the public TMDB web page.
var BASE = "https://aflaam.com";
var UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

function get(url, referer) {
  return fetch(url, { headers: { "User-Agent": UA, Referer: referer || BASE } }).then(function (r) {
    return r.text();
  });
}

function fix(u) {
  if (!u) return u;
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + (u.charAt(0) === "/" ? "" : "/") + u;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
}

function attr(tag, name) {
  var m = new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', "i").exec(tag);
  return m ? m[1] : "";
}

function getTitles(tmdbId, mediaType) {
  var kind = mediaType === "movie" ? "movie" : "tv";
  var out = [];
  function one(lang) {
    var url = "https://www.themoviedb.org/" + kind + "/" + tmdbId + "?language=" + lang;
    return fetch(url, { headers: { "User-Agent": UA, "Accept-Language": lang } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var m = /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i.exec(html) ||
                /<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i.exec(html);
        if (!m) return;
        var t = m[1].replace(/&amp;/g, "&").replace(/&#x27;|&#039;/g, "'").replace(/&quot;/g, '"')
                    .replace(/\s*\(\d{4}\)\s*$/, "").trim();
        if (t) out.push(t);
      }).catch(function () {});
  }
  return one("en-US").then(function () { return one("ar-SA"); }).then(function () {
    var seen = {};
    return out.filter(function (t) { var k = norm(t); if (!k || seen[k]) return false; seen[k] = 1; return true; });
  });
}

// Parse search result cards: <div class="item"> ... <a class="box" href=..> ... <h3 class="entry-title">..</h3>
function parseResults(html) {
  var chunks = html.split(/<div[^>]*class="[^"]*\bitem\b[^"]*"[^>]*>/i).slice(1);
  var res = [];
  chunks.forEach(function (c) {
    var a = /<a[^>]*class="[^"]*\bbox\b[^"]*"[^>]*>/i.exec(c);
    var h = /<h3[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(c);
    if (!a || !h) return;
    var href = attr(a[0], "href");
    if (!href) return;
    res.push({ href: fix(href), title: h[1].replace(/<[^>]+>/g, "").trim() });
  });
  return res;
}

function findMatch(titles, mediaType) {
  var want = mediaType === "movie" ? "/movie/" : "/series/";
  var i = 0;
  function next() {
    if (i >= titles.length) return Promise.resolve(null);
    var t = titles[i++];
    return get(BASE + "/search?q=" + encodeURIComponent(t)).then(function (html) {
      var results = parseResults(html).filter(function (r) { return r.href.indexOf(want) !== -1; });
      var nt = norm(t);
      var exact = results.filter(function (r) { return norm(r.title) === nt; })[0];
      var loose = results.filter(function (r) { var x = norm(r.title); return x.indexOf(nt) !== -1 || nt.indexOf(x) !== -1; })[0];
      return exact || loose || next();
    }).catch(function () { return next(); });
  }
  return next();
}

// Series page: episodes are in div#movie-tab-1 > div.entry-box-3. The site lists them flat, with no season split.
function findEpisodeUrl(seriesUrl, episode) {
  return get(seriesUrl).then(function (html) {
    var tab = html.split(/id="movie-tab-1"/i)[1] || html;
    tab = tab.split(/id="movie-tab-2"/i)[0];
    var boxes = tab.split(/<div[^>]*class="[^"]*entry-box-3[^"]*"[^>]*>/i).slice(1);
    for (var i = 0; i < boxes.length; i++) {
      var link = /<a[^>]*href="([^"]+)"/i.exec(boxes[i]);
      var num = /<span[^>]*class="[^"]*font-size-50[^"]*"[^>]*>\s*(\d+)/i.exec(boxes[i]);
      if (link && num && parseInt(num[1], 10) === episode) return fix(link[1]);
    }
    return null;
  });
}

function extractFromWatchPage(url) {
  return get(url).then(function (html) {
    var vid = /<video[^>]*id="player"[\s\S]*?<\/video>/i.exec(html);
    var out = [];
    if (!vid) return out;
    var re = /<source[^>]*>/gi, m;
    while ((m = re.exec(vid[0]))) {
      var src = attr(m[0], "src");
      if (!src) continue;
      var size = attr(m[0], "size") || "720";
      out.push({
        name: "Aflaam",
        title: "Aflaam - " + size + "p",
        url: fix(src),
        quality: size + "p",
        headers: { Referer: BASE, "User-Agent": UA }
      });
    }
    return out;
  }).catch(function () { return []; });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return getTitles(tmdbId, mediaType).then(function (titles) {
    if (!titles.length) return [];
    return findMatch(titles, mediaType).then(function (match) {
      if (!match) return [];
      var pageP = mediaType === "movie" ? Promise.resolve(match.href) : findEpisodeUrl(match.href, episode);
      return pageP.then(function (pageUrl) {
        if (!pageUrl) return [];
        return get(pageUrl).then(function (html) {
          var links = [];
          var re = /<a[^>]*class="[^"]*link-show[^"]*"[^>]*>/gi, m;
          while ((m = re.exec(html))) {
            var h = attr(m[0], "href");
            if (h) links.push(fix(h));
          }
          return Promise.all(links.map(extractFromWatchPage)).then(function (lists) {
            return [].concat.apply([], lists);
          });
        });
      });
    });
  }).catch(function () { return []; });
}

module.exports = { getStreams: getStreams };