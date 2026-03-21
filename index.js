const express = require("express");
const path = require("path");
const yts = require("youtube-search-api");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");

const app = express();
const port = process.env.PORT || 3000;

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

const API_HEALTH_CHECKER = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const TEMP_API_LIST = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";

app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

let apiListCache = [];

// APIキャッシュの更新
async function updateApiListCache() {
  try {
    const response = await fetch(API_HEALTH_CHECKER);
    if (response.ok) {
      const mainApiList = await response.json();
      if (Array.isArray(mainApiList) && mainApiList.length > 0) {
        apiListCache = mainApiList;
        console.log("API List updated.");
      }
    }
  } catch (err) {
    console.error("API update failed, using fallback.");
  }
}

updateApiListCache();
setInterval(updateApiListCache, 1000 * 60 * 10); // 10分ごとに更新

function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
    )
  ]);
}

// ミドルウェア: 人間確認 (既存ロジックを継承)
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/video") || req.path === "/") {
    if (!req.cookies || req.cookies.humanVerified !== "true") {
      const pages = [
        'https://raw.githubusercontent.com/mino-hobby-pro/gisou-min2/refs/heads/main/3d.txt',
        'https://raw.githubusercontent.com/mino-hobby-pro/gisou-min2/refs/heads/main/math.txt',
        'https://raw.githubusercontent.com/mino-hobby-pro/gisou-min2/refs/heads/main/study.txt'
      ];
      const randomPage = pages[Math.floor(Math.random() * pages.length)];
      try {
        const response = await fetch(randomPage);
        const htmlContent = await response.text();
        return res.render("robots", { content: htmlContent });
      } catch (err) {
        return res.render("robots", { content: "<p>Verification Required</p>" });
      }
    }
  }
  next();
});

// --- API ENDPOINTS ---

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/api/search", async (req, res, next) => {
  const query = req.query.q;
  const page = req.query.page || 0;
  if (!query) return res.status(400).json({ error: "Query required" });
  try {
    const results = await yts.GetListByKeyword(query, false, 20, page);
    res.json(results);
  } catch (err) { next(err); }
});

// 高度なレコメンドアルゴリズム用エンドポイント
app.get("/api/recommendations", async (req, res) => {
  const { title, channel } = req.query;
  try {
    // 1. タイトルから重要なキーワードを抽出（記号を削除し、長い単語を優先）
    const keywords = title
      .replace(/[【】「」()!！?？\[\]]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 3)
      .join(' ');

    // 2. キーワード + チャンネル名で検索して関連性を高める
    const searchResults = await yts.GetListByKeyword(`${keywords} ${channel}`, false, 15);
    
    // 3. 結果をシャッフルして「新発見」感を出す
    const shuffled = (searchResults.items || []).sort(() => 0.5 - Math.random());
    
    res.json({ items: shuffled });
  } catch (err) {
    res.json({ items: [] });
  }
});

// --- VIDEO PAGE ---

app.get("/video/:id", async (req, res, next) => {
  const videoId = req.params.id;
  
  try {
    let videoData = null;
    let commentsData = { commentCount: 0, comments: [] };
    let successfulApi = null;

    // APIリストから動画情報を取得
    for (const apiBase of apiListCache) {
      try {
        const response = await fetchWithTimeout(`${apiBase}/api/video/${videoId}`, {}, 6000);
        if (response.ok) {
          const data = await response.json();
          if (data.stream_url) {
            videoData = data;
            successfulApi = apiBase;
            break;
          }
        }
      } catch (e) { continue; }
    }

    if (!videoData) {
      videoData = { videoTitle: "再生できない動画", stream_url: "youtube-nocookie" };
    }

    // コメント取得
    if (successfulApi) {
      try {
        const cRes = await fetchWithTimeout(`${successfulApi}/api/comments/${videoId}`, {}, 3000);
        if (cRes.ok) commentsData = await cRes.json();
      } catch (e) {}
    }

    const streamEmbed = videoData.stream_url !== "youtube-nocookie"
      ? `<video controls autoplay poster="https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg">
           <source src="${videoData.stream_url}" type="video/mp4">
         </video>`
      : `<iframe src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1" frameborder="0" allowfullscreen></iframe>`;

    // HTMLテンプレート生成
    const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoData.videoTitle} - YouTube Pro</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        :root {
            --bg-main: #0f0f0f;
            --bg-secondary: #272727;
            --bg-hover: #3f3f3f;
            --text-main: #f1f1f1;
            --text-sub: #aaaaaa;
            --yt-red: #ff0000;
        }
        body {
            margin: 0; padding: 0;
            background: var(--bg-main);
            color: var(--text-main);
            font-family: "Roboto", "Arial", sans-serif;
            overflow-x: hidden;
        }

        /* Navbar */
        .navbar {
            position: fixed; top: 0; width: 100%; height: 56px;
            background: var(--bg-main);
            display: flex; align-items: center; justify-content: space-between;
            padding: 0 16px; box-sizing: border-box; z-index: 1000;
        }
        .nav-left { display: flex; align-items: center; gap: 16px; font-size: 20px; }
        .logo { display: flex; align-items: center; color: white; text-decoration: none; font-weight: bold; letter-spacing: -1px; }
        .logo i { color: var(--yt-red); font-size: 24px; margin-right: 4px; }
        
        .nav-center { flex: 0 1 720px; display: flex; align-items: center; }
        .search-bar {
            display: flex; width: 100%;
            background: #121212; border: 1px solid #303030; border-radius: 40px 0 0 40px;
            padding: 0 16px; margin-left: 32px;
        }
        .search-bar input {
            width: 100%; background: transparent; border: none; color: white;
            height: 40px; font-size: 16px; outline: none;
        }
        .search-btn {
            background: #222; border: 1px solid #303030; border-left: none;
            border-radius: 0 40px 40px 0; width: 64px; height: 40px;
            color: white; cursor: pointer;
        }

        /* Layout */
        .container {
            margin-top: 72px; display: flex; justify-content: center;
            padding: 0 24px; gap: 24px; max-width: 1700px; margin-left: auto; margin-right: auto;
        }
        .main-content { flex: 1; max-width: 1280px; }
        .sidebar { width: 400px; flex-shrink: 0; }

        /* Player */
        .player-container {
            width: 100%; aspect-ratio: 16 / 9;
            background: black; border-radius: 12px; overflow: hidden;
        }
        .player-container video, .player-container iframe { width: 100%; height: 100%; border: none; }

        /* Video Info */
        .video-title { font-size: 20px; font-weight: bold; margin: 12px 0 8px 0; line-height: 28px; }
        .owner-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .owner-info { display: flex; align-items: center; gap: 12px; }
        .owner-info img { width: 40px; height: 40px; border-radius: 50%; background: #333; }
        .channel-name { font-weight: bold; font-size: 16px; }
        .sub-count { font-size: 12px; color: var(--text-sub); }
        .btn-sub {
            background: white; color: black; border: none;
            padding: 0 16px; height: 36px; border-radius: 18px;
            font-weight: bold; cursor: pointer; margin-left: 12px;
        }
        .actions { display: flex; gap: 8px; }
        .action-btn {
            background: var(--bg-secondary); border: none; color: white;
            padding: 0 16px; height: 36px; border-radius: 18px;
            cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 14px;
        }
        .action-btn:hover { background: var(--bg-hover); }

        /* Description */
        .description-box {
            background: var(--bg-secondary); border-radius: 12px;
            padding: 12px; font-size: 14px; line-height: 20px;
            cursor: pointer; transition: 0.2s;
        }
        .description-box:hover { background: #333; }
        .stats { font-weight: bold; margin-bottom: 4px; }

        /* Comments */
        .comments-section { margin-top: 24px; }
        .comment-item { display: flex; gap: 16px; margin-bottom: 24px; }
        .comment-avatar { width: 40px; height: 40px; border-radius: 50%; }
        .comment-right { flex: 1; }
        .comment-header { font-size: 13px; margin-bottom: 4px; }
        .comment-author { font-weight: bold; margin-right: 8px; }
        .comment-text { font-size: 14px; color: #f1f1f1; white-space: pre-wrap; }

        /* Recommendations */
        .rec-item { display: flex; gap: 8px; margin-bottom: 12px; cursor: pointer; text-decoration: none; color: inherit; }
        .rec-thumb { position: relative; width: 168px; height: 94px; flex-shrink: 0; border-radius: 8px; overflow: hidden; background: #222; }
        .rec-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .rec-info { flex: 1; }
        .rec-title { font-size: 14px; font-weight: bold; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
        .rec-meta { font-size: 12px; color: var(--text-sub); }

        @media (max-width: 1100px) {
            .container { flex-direction: column; padding: 0; }
            .sidebar { width: 100%; padding: 12px; box-sizing: border-box; }
            .main-content { padding: 12px; }
            .player-container { border-radius: 0; }
        }
    </style>
</head>
<body>

<nav class="navbar">
    <div class="nav-left">
        <i class="fas fa-bars"></i>
        <a href="/" class="logo"><i class="fab fa-youtube"></i>YouTube<sup>Pro</sup></a>
    </div>
    <div class="nav-center">
        <form class="search-bar" action="/nothing/search">
            <input type="text" name="q" placeholder="検索">
            <button type="submit" class="search-btn"><i class="fas fa-search"></i></button>
        </form>
    </div>
    <div class="nav-right" style="font-size: 20px; display:flex; gap:20px;">
        <i class="fas fa-video"></i>
        <i class="fas fa-bell"></i>
        <i class="fas fa-user-circle"></i>
    </div>
</nav>

<div class="container">
    <div class="main-content">
        <div class="player-container">
            ${streamEmbed}
        </div>
        
        <h1 class="video-title">${videoData.videoTitle}</h1>
        
        <div class="owner-row">
            <div class="owner-info">
                <img src="${videoData.channelImage || 'https://via.placeholder.com/40'}" alt="avatar">
                <div>
                    <div class="channel-name">${videoData.channelName || 'Unknown Channel'}</div>
                    <div class="sub-count">チャンネル登録者数 非表示</div>
                </div>
                <button class="btn-sub">チャンネル登録</button>
            </div>
            <div class="actions">
                <div class="action-btn"><i class="far fa-thumbs-up"></i> ${videoData.likeCount || 0}</div>
                <div class="action-btn"><i class="fas fa-share"></i> 共有</div>
                <div class="action-btn"><i class="fas fa-download"></i> オフライン</div>
                <div class="action-btn">...</div>
            </div>
        </div>

        <div class="description-box" id="descBox">
            <div class="stats">${videoData.videoViews || '0'} 回視聴  2024/03/21</div>
            <div id="descText">${videoData.videoDes || '説明はありません。'}</div>
        </div>

        <div class="comments-section">
            <h3>コメント ${commentsData.commentCount} 件</h3>
            <div id="commentsList">
                ${commentsData.comments.map(c => `
                    <div class="comment-item">
                        <img class="comment-avatar" src="${c.authorThumbnails?.[0]?.url || 'https://via.placeholder.com/40'}">
                        <div class="comment-right">
                            <div class="comment-header">
                                <span class="comment-author">${c.author}</span>
                                <span style="color:var(--text-sub)">${c.publishedText || ''}</span>
                            </div>
                            <div class="comment-text">${c.content}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>

    <div class="sidebar">
        <div id="recommendations">
            <p style="padding:20px; color:var(--text-sub);">おすすめを読み込み中...</p>
        </div>
    </div>
</div>

<script>
    // 完璧なレコメンドアルゴリズムの実行
    async function loadRecommendations() {
        const title = encodeURIComponent("${videoData.videoTitle}");
        const channel = encodeURIComponent("${videoData.channelName}");
        const res = await fetch(\`/api/recommendations?title=\${title}&channel=\${channel}\`);
        const data = await res.json();
        
        const recContainer = document.getElementById('recommendations');
        if (!data.items || data.items.length === 0) {
            recContainer.innerHTML = "<p>おすすめが見つかりませんでした</p>";
            return;
        }

        recContainer.innerHTML = data.items.map(item => \`
            <a href="/video/\${item.id}" class="rec-item">
                <div class="rec-thumb">
                    <img src="https://i.ytimg.com/vi/\${item.id}/mqdefault.jpg">
                </div>
                <div class="rec-info">
                    <div class="rec-title">\${item.title}</div>
                    <div class="rec-meta">
                        \${item.channelTitle || 'YouTube Pro'}<br>
                        \${item.viewCount || ''}
                    </div>
                </div>
            </a>
        \`).join('');
    }

    // 説明文の折りたたみ
    const descBox = document.getElementById('descBox');
    descBox.onclick = () => {
        descBox.style.cursor = 'default';
        document.getElementById('descText').style.whiteSpace = 'pre-wrap';
    };

    window.onload = loadRecommendations;
</script>

</body>
</html>
    `;
    res.send(html);
  } catch (err) { next(err); }
});

// --- OTHERS ---
app.get("/nothing/*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

// 404/500 Handling
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "public", "error.html")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).sendFile(path.join(__dirname, "public", "error.html"));
});

app.listen(port, () => console.log(`YouTube Pro is running on port \${port}`));
