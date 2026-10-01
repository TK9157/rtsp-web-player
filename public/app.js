/**
 * SENTINEL-X RTSP WAN Streamer - Frontend Controller
 * Handles URL formatting, JSMpeg client lifecycle, LocalStorage history, & granular diagnostics
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const rtspInput = document.getElementById('rtsp-input');
  const btnConnect = document.getElementById('btn-connect');
  const btnStop = document.getElementById('btn-stop');
  const btnReconnect = document.getElementById('btn-reconnect');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const presetChips = document.querySelectorAll('.preset-chip');

  const canvas = document.getElementById('video-canvas');
  const videoWrapper = document.getElementById('video-wrapper');
  const placeholder = document.getElementById('canvas-placeholder');
  const historyList = document.getElementById('history-list');
  const diagLogs = document.getElementById('diag-logs');

  const statusText = document.getElementById('status-text');
  const statusBadge = document.getElementById('system-badge');
  const statusDot = statusBadge.querySelector('.status-indicator-dot');
  const liveClock = document.getElementById('live-clock');
  const hudEndpoint = document.getElementById('hud-endpoint-display');
  const hudBitrate = document.getElementById('hud-bitrate-display');

  // Player & Connection state
  let jsmpegPlayer = null;
  let activeWsUrl = null;
  let currentRtspTarget = null;
  let bytesReceivedTotal = 0;
  let bitrateInterval = null;

  const STORAGE_KEY = 'sentinel_rtsp_history_v1';

  // ---------------------------------------------------------
  // 1. Live UTC Clock Initialization
  // ---------------------------------------------------------
  const updateClock = () => {
    const now = new Date();
    liveClock.textContent = now.toISOString().substring(11, 19) + ' UTC';
  };
  setInterval(updateClock, 1000);
  updateClock();

  // ---------------------------------------------------------
  // 2. Intelligent Endpoint Normalization & Sanitization
  // ---------------------------------------------------------
  const formatRtspUrl = (rawInput) => {
    let clean = rawInput.trim();
    if (!clean) return '';

    // Strip leading rtsp:// or rtsps:// if present to parse domain/IP cleanly
    let hasRtspPrefix = /^rtsps?:\/\//i.test(clean);
    let targetCore = clean.replace(/^rtsps?:\/\//i, '');

    // Check if input is pure IP or Hostname without credentials/ports/paths
    // e.g. "103.25.10.45" or "camera.dyndns.org"
    const pureHostRegex = /^([a-zA-Z0-9.-]+)$/;
    if (pureHostRegex.test(targetCore)) {
      return `rtsp://${targetCore}:554`;
    }

    // Check if input is host:port without path e.g. "103.25.10.45:554"
    const hostPortRegex = /^([a-zA-Z0-9.-]+):(\d+)$/;
    if (hostPortRegex.test(targetCore)) {
      return `rtsp://${targetCore}`;
    }

    // Return with mandatory rtsp:// prefix preserved or added
    return hasRtspPrefix ? clean : `rtsp://${clean}`;
  };

  // Real-time input formatter on blur or typing
  rtspInput.addEventListener('blur', () => {
    if (rtspInput.value) {
      rtspInput.value = formatRtspUrl(rtspInput.value);
    }
  });

  // Preset chip handler
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const subpath = chip.getAttribute('data-path');
      let val = rtspInput.value.trim();
      if (!val) {
        val = '103.25.10.45:554';
      }
      val = formatRtspUrl(val);
      // Append path if not already present
      if (!val.includes(subpath)) {
        // Strip trailing slashes
        val = val.replace(/\/+$/, '') + subpath;
      }
      rtspInput.value = val;
      logDiag(`[INPUT] Appended path preset: ${subpath}`, 'text-zinc-400');
    });
  });

  // ---------------------------------------------------------
  // 3. Diagnostics Logger Utility
  // ---------------------------------------------------------
  const logDiag = (message, colorClass = 'text-zinc-300') => {
    const timestamp = new Date().toISOString().substring(11, 19);
    const line = document.createElement('div');
    line.className = `log-line ${colorClass}`;
    line.textContent = `[${timestamp}] ${message}`;
    diagLogs.appendChild(line);
    diagLogs.scrollTop = diagLogs.scrollHeight;
  };

  // ---------------------------------------------------------
  // 4. Connection State Machine
  // ---------------------------------------------------------
  const setConnectionState = (state, details = '') => {
    statusDot.className = 'status-indicator-dot';
    switch (state) {
      case 'IDLE':
        statusDot.classList.add('idle');
        statusText.textContent = 'SYSTEM IDLE';
        btnConnect.disabled = false;
        btnStop.disabled = true;
        btnReconnect.disabled = true;
        placeholder.style.opacity = '1';
        placeholder.style.pointerEvents = 'auto';
        hudEndpoint.textContent = 'NO SOURCE CONNECTED';
        logDiag(`[STATE] Idle.`, 'text-zinc-500');
        break;

      case 'RESOLVING':
        statusDot.classList.add('connecting');
        statusText.textContent = 'RESOLVING & HANDSHAKING...';
        btnConnect.disabled = true;
        btnStop.disabled = false;
        btnReconnect.disabled = true;
        logDiag(`[STATE] Handshaking camera endpoint over WAN TCP...`, 'text-amber-400');
        break;

      case 'STREAMING':
        statusDot.classList.add('streaming');
        statusText.textContent = 'STREAMING LIVE (TCP)';
        btnConnect.disabled = true;
        btnStop.disabled = false;
        btnReconnect.disabled = false;
        placeholder.style.opacity = '0';
        placeholder.style.pointerEvents = 'none';
        hudEndpoint.textContent = currentRtspTarget;
        logDiag(`[STATE] Live video pipe established successfully.`, 'text-emerald-400');
        break;

      case 'LOST':
        statusDot.classList.add('connecting');
        statusText.textContent = 'STREAM LOST / RETRYING';
        btnConnect.disabled = true;
        btnStop.disabled = false;
        btnReconnect.disabled = false;
        logDiag(`[STATE] Video feed dropped. Retrying stream...`, 'text-amber-400');
        break;

      case 'ERROR':
        statusDot.classList.add('error');
        statusText.textContent = details || 'AUTHENTICATION OR HOST UNREACHABLE';
        btnConnect.disabled = false;
        btnStop.disabled = true;
        btnReconnect.disabled = false;
        placeholder.style.opacity = '1';
        placeholder.style.pointerEvents = 'auto';
        logDiag(`[ERROR] ${details || 'Connection failed or timed out.'}`, 'text-rose-400');
        break;
    }
  };

  // ---------------------------------------------------------
  // 5. JSMpeg Player Lifecycle Controller
  // ---------------------------------------------------------
  const startStream = (rtspUrl) => {
    stopStream(); // Ensure previous process & socket are destroyed

    const formattedTarget = formatRtspUrl(rtspUrl);
    if (!formattedTarget) {
      alert('Please enter a valid IP address or RTSP URL');
      return;
    }

    currentRtspTarget = formattedTarget;
    rtspInput.value = formattedTarget;
    saveToHistory(formattedTarget);

    // Build backend WebSocket query URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    activeWsUrl = `${protocol}//${window.location.host}/api/stream?url=${encodeURIComponent(formattedTarget)}`;

    setConnectionState('RESOLVING');
    logDiag(`[WS] Connecting relay to ${activeWsUrl}`);

    bytesReceivedTotal = 0;
    startBitrateMonitor();

    try {
      // Instantiate JSMpeg player over WebSocket
      jsmpegPlayer = new JSMpeg.Player(activeWsUrl, {
        canvas: canvas,
        autoplay: true,
        audio: false,
        loop: false,
        onVideoDecode: () => {
          if (statusText.textContent !== 'STREAMING LIVE (TCP)') {
            setConnectionState('STREAMING');
          }
        },
        onSourceCompleted: () => {
          logDiag(`[JSMpeg] Source completed or closed by server.`, 'text-zinc-400');
          setConnectionState('IDLE');
        }
      });

      // Hook underlying source websocket for error tracking
      if (jsmpegPlayer && jsmpegPlayer.source && jsmpegPlayer.source.socket) {
        const socket = jsmpegPlayer.source.socket;
        
        socket.addEventListener('message', (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            bytesReceivedTotal += ev.data.byteLength;
          }
        });

        socket.addEventListener('error', (err) => {
          console.error('JSMpeg Socket Error:', err);
          setConnectionState('ERROR', 'Host unreachable or socket failed');
        });

        socket.addEventListener('close', (e) => {
          if (statusText.textContent === 'STREAMING LIVE (TCP)') {
            setConnectionState('LOST');
          }
        });
      }

    } catch (err) {
      console.error('Failed to initialize JSMpeg player:', err);
      setConnectionState('ERROR', err.message);
    }
  };

  const stopStream = () => {
    stopBitrateMonitor();
    if (jsmpegPlayer) {
      try {
        logDiag(`[CLEANUP] Destroying JSMpeg player instance & socket`);
        jsmpegPlayer.destroy();
      } catch (e) {
        console.warn('Error destroying player:', e);
      }
      jsmpegPlayer = null;
    }
    setConnectionState('IDLE');
  };

  // ---------------------------------------------------------
  // 6. Bitrate Monitoring Calculation
  // ---------------------------------------------------------
  const startBitrateMonitor = () => {
    stopBitrateMonitor();
    let lastBytes = 0;
    bitrateInterval = setInterval(() => {
      const diff = bytesReceivedTotal - lastBytes;
      lastBytes = bytesReceivedTotal;
      const kbps = ((diff * 8) / 1024).toFixed(0);
      hudBitrate.textContent = `${kbps} KB/S`;
    }, 1000);
  };

  const stopBitrateMonitor = () => {
    if (bitrateInterval) clearInterval(bitrateInterval);
    hudBitrate.textContent = '0 KB/S';
  };

  // ---------------------------------------------------------
  // 7. LocalStorage History Management (Last 10 Items)
  // ---------------------------------------------------------
  const loadHistory = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  };

  const saveToHistory = (url) => {
    let history = loadHistory();
    // Filter duplicates
    history = history.filter(item => item !== url);
    // Prepend latest item
    history.unshift(url);
    // Limit to max 10 items
    if (history.length > 10) history = history.slice(0, 10);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.warn('LocalStorage error:', e);
    }
    renderHistory();
  };

  const renderHistory = () => {
    const history = loadHistory();
    historyList.innerHTML = '';

    if (history.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No recent endpoints saved.</div>';
      return;
    }

    history.forEach((url) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.title = url;
      item.innerHTML = `
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px;">${url}</span>
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
      `;
      item.addEventListener('click', () => {
        rtspInput.value = url;
        startStream(url);
      });
      historyList.appendChild(item);
    });
  };

  btnClearHistory.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
    logDiag(`[HISTORY] Cleared endpoint history.`, 'text-zinc-500');
  });

  // ---------------------------------------------------------
  // 8. Event Listeners & Controls
  // ---------------------------------------------------------
  btnConnect.addEventListener('click', () => startStream(rtspInput.value));
  btnStop.addEventListener('click', stopStream);
  btnReconnect.addEventListener('click', () => {
    if (currentRtspTarget) startStream(currentRtspTarget);
  });

  rtspInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      startStream(rtspInput.value);
    }
  });

  // Fullscreen Handler
  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      if (videoWrapper.requestFullscreen) {
        videoWrapper.requestFullscreen();
      } else if (videoWrapper.webkitRequestFullscreen) {
        videoWrapper.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  });

  // Initial setup
  renderHistory();
  setConnectionState('IDLE');
});
