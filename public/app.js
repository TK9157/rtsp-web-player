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
  // 1. Live Indian Standard Time (IST) Clock Initialization
  // ---------------------------------------------------------
  const updateClock = () => {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    if (liveClock) {
      liveClock.textContent = `${timeString} IST`;
    }
  };
  setInterval(updateClock, 1000);
  updateClock();

  // ---------------------------------------------------------
  // 2. Intelligent Endpoint Normalization & Sanitization
  // ---------------------------------------------------------
  const formatRtspUrl = (rawInput) => {
    let clean = rawInput.trim();
    if (!clean) return '';

    let hasRtspPrefix = /^rtsps?:\/\//i.test(clean);
    let targetCore = clean.replace(/^rtsps?:\/\//i, '');

    const pureHostRegex = /^([a-zA-Z0-9.-]+)$/;
    if (pureHostRegex.test(targetCore)) {
      return `rtsp://${targetCore}:554`;
    }

    const hostPortRegex = /^([a-zA-Z0-9.-]+):(\d+)$/;
    if (hostPortRegex.test(targetCore)) {
      return `rtsp://${targetCore}`;
    }

    return hasRtspPrefix ? clean : `rtsp://${clean}`;
  };

  rtspInput.addEventListener('blur', () => {
    if (rtspInput.value) {
      rtspInput.value = formatRtspUrl(rtspInput.value);
    }
  });

  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const subpath = chip.getAttribute('data-path');
      let val = rtspInput.value.trim();
      if (!val) {
        val = '103.25.10.45:554';
      }
      val = formatRtspUrl(val);
      if (!val.includes(subpath)) {
        val = val.replace(/\/+$/, '') + subpath;
      }
      rtspInput.value = val;
      logDiag(`[INPUT] Appended path preset: ${subpath}`, 'text-zinc-400');
    });
  });

  // ---------------------------------------------------------
  // 3. Diagnostics Logger Utility (Localized to IST)
  // ---------------------------------------------------------
  const logDiag = (message, colorClass = 'text-zinc-300') => {
    const timestamp = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const line = document.createElement('div');
    line.className = `log-line ${colorClass}`;
    line.textContent = `[\({timestamp}]\){message}`;
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
  // 5. JSMpeg Player Lifecycle Controller (With Audio Enabled)
  // ---------------------------------------------------------
  const startStream = (rtspUrl) => {
    stopStream();

    const formattedTarget = formatRtspUrl(rtspUrl);
    if (!formattedTarget) {
      alert('Please enter a valid IP address or RTSP URL');
      return;
    }

    currentRtspTarget = formattedTarget;
    rtspInput.value = formattedTarget;
    saveToHistory(formattedTarget);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    activeWsUrl = `\({protocol}//\){window.location.host}/api/stream?url=${encodeURIComponent(formattedTarget)}`;

    setConnectionState('RESOLVING');
    logDiag(`[WS] Connecting relay to ${activeWsUrl}`);

    bytesReceivedTotal = 0;
    startBitrateMonitor();

    try {
      // Audio is set to true; audioBufferSize set to reduce crackle
      jsmpegPlayer = new JSMpeg.Player(activeWsUrl, {
        canvas: canvas,
        autoplay: true,
        audio: true,
        audioBufferSize: 512 * 1024,
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

        socket.addEventListener('close', () => {
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
    history = history.filter(item => item !== url);
    history.unshift(url);
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
      historyList.innerHTML = '
