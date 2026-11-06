const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit({ windowMs: 60000, max: 30 }));

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
  return 'Autre';
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function addHistory(entry) {
  const all = readHistory();
  all.unshift(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(all.slice(0, 200), null, 2));
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'URL invalide' });
    }
    console.log('[ANALYZE]', url);

    const info = await youtubedl(url, {
  dumpSingleJson: true,
  noWarnings: true,
  skipDownload: true,
  preferFreeFormats: true,
  cookies: 'youtube.com_cookies.txt',
});

    const formats = (info.formats || [])
      .filter((f) => f.url)
      .map((f) => ({
        id: f.format_id,
        quality: f.format_note || f.resolution || (f.acodec !== 'none' ? 'Audio' : 'N/A'),
        ext: f.ext,
        sizeMB: f.filesize ? +(f.filesize / 1e6).toFixed(2) : null,
        hasVideo: f.vcodec && f.vcodec !== 'none',
        hasAudio: f.acodec && f.acodec !== 'none',
      }))
      .slice(0, 20);

    const data = {
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader || info.channel,
      platform: detectPlatform(url),
      formats,
    };

    addHistory({
      url,
      title: info.title,
      platform: data.platform,
      date: new Date().toISOString(),
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[ANALYZE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'URL invalide' });
    }
    console.log('[DOWNLOAD]', url);

    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      format: 'best',
      mergeOutputFormat: 'mp4',
     scookies: 'youtube.com_cookies.txt',
    });

    const chosen = (info.formats || [])[0] || info;
    if (!chosen || !chosen.url) {
      return res.status(500).json({ error: 'Format introuvable' });
    }

    const filename = (info.title || 'media').replace(/[<>:"/\\|?*]/g, '').slice(0, 100) + '.mp4';
    const proxyUrl = '/api/proxy?url=' + encodeURIComponent(chosen.url) + '&name=' + encodeURIComponent(filename);

    res.json({ success: true, downloadUrl: proxyUrl, filename });
  } catch (err) {
    console.error('[DOWNLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proxy', async (req, res) => {
  try {
    const target = req.query.url;
    const filename = req.query.name || 'media.mp4';
    if (!target || !isValidUrl(target)) {
      return res.status(400).json({ error: 'URL invalide' });
    }

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok || !response.body) {
      return res.status(502).json({ error: 'Impossible de recuperer le fichier' });
    }

    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
    const len = response.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');

    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) return res.end();
      res.write(Buffer.from(value));
      return pump();
    };
    await pump();
  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json({ success: true, data: readHistory().slice(0, 50) });
});

app.listen(PORT, () => {
  console.log('');
  console.log('===========================================');
  console.log('  MediaGrab Backend demarre');
  console.log('  http://localhost:' + PORT);
  console.log('  http://localhost:' + PORT + '/api/health');
  console.log('===========================================');
  console.log('');
});