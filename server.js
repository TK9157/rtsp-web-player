const express = require('express');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server for RTSP stream relay
const wss = new WebSocket.Server({ server, path: '/api/stream' });

wss.on('connection', (ws, req) => {
  // Parse RTSP URL from query parameters
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const rtspUrl = urlParams.get('url');

  console.log(`[WS] Client connected requesting stream: ${rtspUrl}`);

  if (!rtspUrl || (!rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('rtsps://'))) {
    console.error('[WS] Rejected connection: Invalid RTSP URL parameter');
    ws.send(JSON.stringify({ error: 'Invalid or missing RTSP URL parameter' }));
    ws.close(1008, 'Invalid RTSP URL');
    return;
  }

  let ffmpegProcess = null;

  // Build FFmpeg arguments optimized for remote WAN streaming & low latency with Audio
  const ffmpegArgs = [
    '-loglevel', 'error',
    // Remote WAN Hardening: Force TCP transport
    '-rtsp_transport', 'tcp',
    // 5-second socket timeout in microseconds
    '-timeout', '5000000',
    '-i', rtspUrl,
    // Container format for JSMpeg
    '-f', 'mpegts',
    // Video transcoding
    '-codec:v', 'mpeg1video',
    '-b:v', '1200k',
    '-maxrate', '1500k',
    '-bufsize', '3000k',
    '-r', '25',
    '-s', '1280x720',
    // Audio transcoding for JSMpeg WebAudio decoder
    '-codec:a', 'mp2',
    '-ar', '44100',
    '-ac', '1',
    '-b:a', '128k',
    '-'
  ];

  console.log(`[FFmpeg] Spawning transcode process for ${rtspUrl}`);
  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stdout.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    console.warn(`[FFmpeg Log] ${msg.trim()}`);
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[FFmpeg Error] Failed to start process: ${err.message}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ error: 'FFmpeg execution error: ' + err.message }));
      ws.close(1011, 'FFmpeg error');
    }
  });

  ffmpegProcess.on('close', (code, signal) => {
    console.log(`[FFmpeg] Process exited with code \({code}, signal\){signal}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'FFmpeg stream terminated');
    }
  });

  // Teardown listener: Kill FFmpeg immediately on client disconnect
  const cleanup = () => {
    if (ffmpegProcess) {
      console.log(`[WS] Terminating FFmpeg child process PID ${ffmpegProcess.pid}`);
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch (e) {
        console.error(`[WS] Error killing FFmpeg process: ${e.message}`);
      }
      ffmpegProcess = null;
    }
  };

  ws.on('close', (code, reason) => {
    console.log(`[WS] Client disconnected (\({code} -\){reason})`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error: ${err.message}`);
    cleanup();
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 RTSP WAN Streamer Server running on port ${PORT}`);
  console.log(`📺 Web Interface: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
