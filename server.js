const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'animixsupabase.prithvi.store';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc2NzA4MzQ2MCwiZXhwIjo0OTIyNzU3MDYwLCJyb2xlIjoic2VydmljZV9yb2xlIn0.BQOjS3G3ESHcFWQL8Sm6726pdx2XT_WmiRli_dlMXEs'; // Use Service Key to bypass RLS for updates
const UPLOAD_DIR = './uploads';
const DOMAIN = process.env.DOMAIN || 'https://myhost.prithvi.store';

const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.static('public')); // Serve the React frontend (if built)
app.use('/videos', express.static(UPLOAD_DIR)); // Serve video files directly from VPS

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => cb(null, `raw-${Date.now()}-${file.originalname}`)
    }) 
});

// Helper: Generate unique slug
const generateSlug = () => Math.random().toString(36).substring(2, 10);

// API: Upload & Process
app.post('/api/upload', upload.single('video'), async (req, res) => {
    const userId = req.body.userId; // Passed from frontend
    if (!req.file || !userId) return res.status(400).json({ error: 'Missing file or user' });

    const slug = generateSlug();
    const videoDir = path.join(UPLOAD_DIR, slug);
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir);

    // 1. Create Initial Record in Supabase
    const { data, error } = await supabase
        .from('streamhost_videos')
        .insert([{
            user_id: userId,
            title: req.file.originalname.replace(/\.[^/.]+$/, ""),
            slug: slug,
            status: 'processing',
            folder_path: videoDir
        }])
        .select()
        .single();

    if (error) {
        console.error('DB Insert Error:', error);
        return res.status(500).json({ error: 'Database error' });
    }

    // 2. Start Transcoding (Async - don't wait for response)
    res.json({ success: true, slug: slug }); // Respond to frontend immediately

    const inputPath = req.file.path;
    const masterPlaylist = path.join(videoDir, 'master.m3u8');

    ffmpeg(inputPath)
        .outputOptions([
            '-preset veryfast', '-g 48', '-sc_threshold 0',
            '-map 0:v:0', '-map 0:a:0', '-map 0:v:0', '-map 0:a:0', '-map 0:v:0', '-map 0:a:0',
            '-s:v:0 1920x1080', '-c:v:0 libx264', '-b:v:0 4500k',
            '-s:v:1 1280x720',  '-c:v:1 libx264', '-b:v:1 2500k',
            '-s:v:2 854x480',   '-c:v:2 libx264', '-b:v:2 1000k',
            '-master_pl_name master.m3u8',
            '-f hls', '-hls_time 6', '-hls_list_size 0',
            '-hls_segment_filename ' + path.join(videoDir, 'v%v_seg%d.ts'),
            '-var_stream_map v:0,a:0 v:1,a:1 v:2,a:2'
        ])
        .output(path.join(videoDir, 'v%v.m3u8'))
        .on('end', async () => {
            console.log(`Transcoding finished for ${slug}`);
            // Generate Thumbnail (simple)
            // Cleanup raw file
            fs.unlinkSync(inputPath);

            // Update Supabase
            await supabase
                .from('streamhost_videos')
                .update({ 
                    status: 'ready',
                    qualities: ['1080p', '720p', '480p']
                })
                .eq('slug', slug);
        })
        .on('error', async (err) => {
            console.error('Transcoding Error:', err);
            await supabase.from('streamhost_videos').update({ status: 'error' }).eq('slug', slug);
        })
        .run();
});

// API: Embed Page Endpoint
// Returns a simple HTML page with the player for iframe usage
app.get('/embed/:slug', async (req, res) => {
    const { slug } = req.params;
    
    // Check if video exists/is ready
    const { data: video } = await supabase.from('streamhost_videos').select('*').eq('slug', slug).single();

    if (!video || video.status !== 'ready') return res.status(404).send('Video not available');

    const videoUrl = `${DOMAIN}/videos/${slug}/master.m3u8`;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <style>body{margin:0;background:#000;overflow:hidden;}video{width:100vw;height:100vh;}</style>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
            <script src="https://cdn.plyr.io/3.8.3/plyr.js"></script>
            <link rel="stylesheet" href="https://cdn.plyr.io/3.8.3/plyr.css" />
        </head>
        <body>
            <video id="player" controls crossorigin playsinline></video>
            <script>
                const source = "${videoUrl}";
                const video = document.getElementById('player');
                const defaultOptions = { controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'] };
                
                if (Hls.isSupported()) {
                    const hls = new Hls();
                    hls.loadSource(source);
                    hls.attachMedia(video);
                    window.player = new Plyr(video, defaultOptions);
                } else {
                    video.src = source;
                    window.player = new Plyr(video, defaultOptions);
                }
            </script>
        </body>
        </html>
    `);
});

const PORT = 3005;
app.listen(PORT, () => console.log(`VPS Server running on port ${PORT}`));