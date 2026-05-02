import React, { useEffect, useRef, useState } from 'react';
import { RadioEngine, Station } from './RadioEngine';

// ULTRA-ROBUST PERSISTENCE LAYER (V4)
const STORAGE_KEY = 'ANTIGRAVITY_RADIO_STATIONS_FINAL';
const USER_SESSION_KEY = 'ANTIGRAVITY_USER_SESSION';
const REGISTRY_KEY = 'ANTIGRAVITY_COMMUNITY_REGISTRY';
const DEFAULT_STATIONS: Station[] = [];

interface ShazamTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  albumArt?: string;
  spotifyUrl?: string;
  appleMusicUrl?: string;
  timestamp: string;
}

interface User {
  id: string;
  name: string;
  avatar?: string;
  genreVibe: string[];
  stations: Station[];
  shazamHistory?: ShazamTrack[];
}

const MOCK_USERS: User[] = [
  { 
    id: 'user_neon', 
    name: 'NeonRider', 
    genreVibe: ['RETROWAVE', 'SYNTH', '80S'],
    stations: [
      { id: 'nts-1', name: 'NTS Radio 1', url: 'https://stream-relay-geo.ntslive.net/stream?client=direct', frequency: 96.8, tags: 'Electronic, Alternative' },
      { id: 'nts-2', name: 'NTS Radio 2', url: 'https://stream-relay-geo.ntslive.net/stream2?client=direct', frequency: 102.4, tags: 'Experimental, Jazz' }
    ]
  },
  { 
    id: 'user_jazz', 
    name: 'MidnightJazz', 
    genreVibe: ['JAZZ', 'LO-FI', 'CHILL'],
    stations: [
      { id: 'fip', name: 'FIP Radio', url: 'https://stream.radiofrance.fr/fip/fip.m3u8?id=radiofrance', frequency: 90.5, tags: 'Jazz, Eclectic' }
    ]
  }
];

const Visualizer: React.FC<{ engine: RadioEngine | null, isStarted: boolean }> = ({ engine, isStarted }) => {
  // ... (keep existing implementation)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current || !engine) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    let animationId: number;
    const draw = () => {
      animationId = requestAnimationFrame(draw);
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Draw faint background grid
      ctx.fillStyle = 'rgba(255, 0, 0, 0.05)';
      for (let i = 0; i < width; i += 4) {
        ctx.fillRect(i, 0, 1, height);
      }
      
      if (!isStarted) return; // Draw empty grid if off
      
      const data = engine.getVisualizerData();
      if (!data) return;
      
      // Render only the first 32 bins (low/mid frequencies are more active)
      const numBars = 32;
      const barWidth = Math.floor(width / numBars);
      const gap = 1;
      let x = 0;
      
      for (let i = 0; i < numBars; i++) {
        const intensity = data[i] / 255;
        // Apply an exponential curve to make peaks pop out more
        const barHeight = Math.pow(intensity, 1.5) * height;
        
        ctx.fillStyle = `rgb(${180 + (intensity * 75)}, ${20 + (intensity * 30)}, 20)`;
        ctx.shadowBlur = 6;
        ctx.shadowColor = `rgba(255, 30, 30, ${intensity})`;
        
        // Render segmented blocks for that true 80s LED/VFD look
        const segments = Math.floor(barHeight / 3);
        const segmentHeight = 2;
        const segmentGap = 1;
        
        for (let j = 0; j < segments; j++) {
           const y = height - (j * (segmentHeight + segmentGap)) - segmentHeight;
           ctx.fillRect(x, y, barWidth - gap, segmentHeight);
        }
        
        x += barWidth;
      }
    };
    draw();
    
    return () => cancelAnimationFrame(animationId);
  }, [engine, isStarted]);

  return <canvas ref={canvasRef} className="visualizer-canvas" width={160} height={30} />;
};

const App: React.FC = () => {
  const [stations, setStations] = useState<Station[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        let parsed = JSON.parse(saved);
        
        // MIGRATION: Update NTS URLs to new stable endpoints
        let migrated = false;
        parsed = parsed.map((s: Station) => {
          if (s.name.toUpperCase().includes('NTS') && s.url.includes('stream-relays.ntslive.net')) {
            migrated = true;
            const channel = s.name.includes('2') ? '2' : '';
            return { ...s, url: `https://stream-relay-geo.ntslive.net/stream${channel}?client=direct` };
          }
          return s;
        });
        
        if (migrated) {
          console.log("[STORAGE] Migration: NTS URLs updated to stable endpoints.");
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }

        console.log(`[STORAGE] Initialization: Loaded ${parsed.length} stations from disk.`);
        return parsed;
      }
    } catch (e) {
      console.error("[STORAGE] Critical error during hydration:", e);
    }
    console.log("[STORAGE] Initialization: Starting with empty memory bank.");
    return DEFAULT_STATIONS;
  });

  const syncToDisk = (list: Station[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      console.log(`[STORAGE] Sync success: ${list.length} stations committed.`);
    } catch (e) {
      console.error("[STORAGE] Sync failed:", e);
    }
  };
  const [freq, setFreq] = useState(88.0);
  const [isStarted, setIsStarted] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [isNormalized, setIsNormalized] = useState(false);
  const [newStation, setNewStation] = useState({ name: '', frequency: 98.0, url: '', tags: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const lastAddedUrlRef = useRef<string | null>(null);
  
  // Filtering states
  const [viewMode, setViewMode] = useState<'custom' | 'filtered'>('custom');
  const [filterTag, setFilterTag] = useState('');
  const [sortBy, setSortBy] = useState<'freq' | 'name'>('freq');
  const [currentMetadata, setCurrentMetadata] = useState<string>('POWER OFF');
  const [isAutoFreq, setIsAutoFreq] = useState(true);
  
  // Shazam Integration States (AudD.io powered)
  const [isShazamOpen, setIsShazamOpen] = useState(false);
  const [auddToken, setAuddToken] = useState(() => localStorage.getItem('AUDD_API_TOKEN') || '');
  const [auddTokenInput, setAuddTokenInput] = useState('');
  const isShazamLoggedIn = auddToken.length > 5;
  const [isShazamScanning, setIsShazamScanning] = useState(false);
  const [isShazamListening, setIsShazamListening] = useState(false);
  const [shazamResult, setShazamResult] = useState<ShazamTrack | null>(null);
  
  // Community & Social States
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem(USER_SESSION_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [userRegistry, setUserRegistry] = useState<User[]>(() => {
    const saved = localStorage.getItem(REGISTRY_KEY);
    if (saved) return JSON.parse(saved);
    return MOCK_USERS;
  });
  const [backupStations, setBackupStations] = useState<Station[] | null>(null);
  const [loginInput, setLoginInput] = useState('');
  
  const engineRef = useRef<RadioEngine | null>(null);

  useEffect(() => {
    if (!engineRef.current) {
      engineRef.current = new RadioEngine(stations);
    }
  }, []);

  // Automatic persistence observer (Redundant Safety Net)
  useEffect(() => {
    if (stations.length > 0) {
      syncToDisk(stations);
    }
  }, [stations]);

  useEffect(() => {
    if (isStarted && engineRef.current) {
      engineRef.current.updateTuning(freq);
      updateMetadata();
    }
  }, [freq, isStarted]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isStarted) updateMetadata();
    }, 30000);
    return () => clearInterval(interval);
  }, [freq, isStarted, stations]);

  const updateMetadata = async () => {
    if (!isStarted) return;
    const active = stations.find(s => Math.abs(s.frequency - freq) < 0.4);
    if (!active) {
      setCurrentMetadata('ESTÁTICA');
      return;
    }

    try {
      let info = 'LIVE STREAMING';
      
      if (active.name.includes('NTS')) {
        const res = await fetch('https://www.nts.live/api/v2/live');
        const data = await res.json();
        const channel = active.name.includes('1') ? 0 : 1;
        info = data.results[channel]?.now?.broadcast_title || 'NTS LIVE';
      } else if (active.url.includes('radio.co')) {
        const stationId = active.url.split('/')[3];
        const res = await fetch(`https://public.radio.co/stations/${stationId}/status`);
        const data = await res.json();
        info = data.current_track?.title || 'RADIO.CO STREAM';
      } else if (active.url.includes('radioking')) {
        const res = await fetch('https://api.radioking.io/widget/radio/292531/track/current');
        const data = await res.json();
        const artist = data.artist || '';
        const title = data.title || '';
        info = (artist && title) ? `${artist} - ${title}` : (title || artist || 'RADIOKING LIVE');
      } else if (active.name === 'Lyl Radio') {
        info = 'LYL RADIO LIVE';
      }

      setCurrentMetadata(info.toUpperCase());
    } catch (e) {
      setCurrentMetadata(active.name.toUpperCase());
    }
  };

  const handlePowerToggle = async () => {
    if (!engineRef.current) return;

    if (isStarted) {
      engineRef.current.stop();
      setIsStarted(false);
      setCurrentMetadata('POWER OFF');
    } else {
      await engineRef.current.init();
      engineRef.current.resume();
      engineRef.current.setNormalization(isNormalized);
      setIsStarted(true);
      updateMetadata();
    }
  };

  const toggleNormalization = () => {
    const next = !isNormalized;
    setIsNormalized(next);
    engineRef.current?.setNormalization(next);
  };

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      // Optimized search: Increased limit, ordered by clickcount (popularity), and searching by name
      const baseUrl = 'https://all.api.radio-browser.info/json/stations/search';
      const params = new URLSearchParams({
        name: searchQuery,
        limit: '15',
        hidebroken: 'true',
        order: 'clickcount',
        reverse: 'true'
      });
      
      const resp = await fetch(`${baseUrl}?${params.toString()}`);
      const data = await resp.json();
      
      // Secondary filter to ensure results are relevant
      setSearchResults(data);
      
      if (data.length === 0) {
        // Fallback: try search by tags if name fails
        const tagParams = new URLSearchParams({
          tag: searchQuery,
          limit: '10',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true'
        });
        const tagResp = await fetch(`${baseUrl}?${tagParams.toString()}`);
        const tagData = await tagResp.json();
        setSearchResults(tagData);
      }
    } catch (e) {
      console.error("Search failed", e);
    } finally {
      setIsSearching(false);
    }
  };

  const findAvailableFrequency = (currentStations: Station[]) => {
    if (currentStations.length === 0) return 98.0;
    const sortedFreqs = Array.from(new Set(currentStations.map(s => s.frequency))).sort((a, b) => a - b);
    const points = [88.0, ...sortedFreqs, 108.0];
    let maxGap = 0;
    let targetFreq = 100.0;
    for (let i = 0; i < points.length - 1; i++) {
      const gap = points[i+1] - points[i];
      if (gap > maxGap) {
        maxGap = gap;
        targetFreq = points[i] + gap / 2;
      }
    }
    return parseFloat(targetFreq.toFixed(1));
  };

  const selectSearchResult = (item: any) => {
    const autoFreq = findAvailableFrequency(stations);
    setNewStation(prev => ({
      ...prev,
      name: item.name,
      url: item.url_resolved || item.url,
      tags: item.tags,
      frequency: isAutoFreq ? autoFreq : prev.frequency
    }));
    setSearchResults([]);
    setSearchQuery('');
  };

  const handleAddStation = (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    
    const targetUrl = newStation.url.trim().replace(/\/$/, "").toLowerCase();
    if (!targetUrl) return;

    // Check for duplicates in current state before processing
    if (stations.some(s => (s.url || "").trim().replace(/\/$/, "").toLowerCase() === targetUrl)) {
      alert(`ESTA SEÑAL YA ESTÁ EN MEMORIA`);
      return;
    }

    submittingRef.current = true;
    lastAddedUrlRef.current = targetUrl;
    setIsSubmitting(true);

    const station: Station = {
      id: `user-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      name: (newStation.name || 'UNKNOWN STATION').toUpperCase(),
      frequency: newStation.frequency,
      url: newStation.url.trim(),
      tags: newStation.tags
    };

    // Update state and immediately commit to disk for maximum robustness
    const updated = [...stations, station];
    setStations(updated);
    syncToDisk(updated);

    // Audio Engine Handshake
    engineRef.current?.addStation(station);

    // Transition back to main display
    setTimeout(() => {
      setShowAddPanel(false);
      setIsSubmitting(false);
      submittingRef.current = false;
      lastAddedUrlRef.current = null;
      // Reset form variables
      setNewStation({ 
        name: '', 
        url: '', 
        tags: '', 
        frequency: findAvailableFrequency(updated) 
      });
    }, 400);
  };

  // --- Drag & Drop Reordering Logic ---
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [stationToDelete, setStationToDelete] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (stationToDelete) {
      e.preventDefault();
      return;
    }
    // Prevent drag if the click started on a button or other interactive element
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('.delete-wrapper')) {
      e.preventDefault();
      return;
    }
    setDraggedIndex(index);
  };

  const handleDrop = (targetIndex: number) => {
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    const updatedStations = [...stations];
    const [draggedItem] = updatedStations.splice(draggedIndex, 1);
    updatedStations.splice(targetIndex, 0, draggedItem);

    // Swap Frequencies: The visual order determines who takes which dial position
    // We get all existing frequencies in sorted order (low to high)
    const sortedFrequencies = stations.map(s => s.frequency).sort((a, b) => a - b);
    
    // Assign sorted frequencies back to the new ordering
    const reorderedWithFrequencies = updatedStations.map((s, i) => ({
      ...s,
      frequency: sortedFrequencies[i]
    }));

    setStations(reorderedWithFrequencies);
    syncToDisk(reorderedWithFrequencies);
    engineRef.current?.updateStationsPool(reorderedWithFrequencies);
    setDraggedIndex(null);
  };

  const handleDeleteInit = (e: React.PointerEvent | React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setStationToDelete(id);
  };

  const handleConfirmDelete = (e: React.PointerEvent | React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const updated = stations.filter(s => s.id !== id);
    setStations(updated);
    syncToDisk(updated);
    engineRef.current?.removeStation(id);
    setStationToDelete(null);
  };

  const handleCancelDelete = (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setStationToDelete(null);
  };

  const handleShazamAction = () => {
    if (!isShazamLoggedIn || !engineRef.current) return;
    
    setIsShazamScanning(true);
    setIsShazamListening(true);
    setShazamResult(null);

    const stream = engineRef.current.getStream();
    if (!stream) {
      setShazamResult({ id: 'error', title: 'HARDWARE ERROR', artist: 'NO SIGNAL INPUT', timestamp: '' });
      setIsShazamScanning(false);
      setIsShazamListening(false);
      return;
    }

    const mediaRecorder = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      setIsShazamListening(false);
      const blob = new Blob(chunks, { type: 'audio/webm' });
      console.log(`[SHAZAM] Captured ${blob.size} bytes. Sending to AudD...`);

      try {
        const formData = new FormData();
        formData.append('file', blob, 'capture.webm');
        formData.append('api_token', auddToken);
        formData.append('return', 'spotify,apple_music');

        const resp = await fetch('https://api.audd.io/', { method: 'POST', body: formData });
        const data = await resp.json();
        console.log('[SHAZAM] AudD response:', data);

        if (data.status === 'success' && data.result) {
          const r = data.result;
          const track: ShazamTrack = {
            id: `track-${Date.now()}`,
            title: r.title || 'UNKNOWN TRACK',
            artist: r.artist || 'UNKNOWN ARTIST',
            album: r.album || undefined,
            albumArt: r.spotify?.album?.images?.[0]?.url || undefined,
            spotifyUrl: r.spotify?.external_urls?.spotify || undefined,
            appleMusicUrl: r.apple_music?.url || undefined,
            timestamp: new Date().toLocaleTimeString()
          };
          setShazamResult(track);

          if (currentUser) {
            const updatedHistory = [track, ...(currentUser.shazamHistory || [])].slice(0, 50);
            const updatedUser = { ...currentUser, shazamHistory: updatedHistory };
            setCurrentUser(updatedUser);
            const updatedRegistry = userRegistry.map(u => u.id === currentUser.id ? updatedUser : u);
            setUserRegistry(updatedRegistry);
            localStorage.setItem(REGISTRY_KEY, JSON.stringify(updatedRegistry));
            localStorage.setItem(USER_SESSION_KEY, JSON.stringify(updatedUser));
          }
        } else {
          setShazamResult({ id: 'error', title: 'NO MATCH FOUND', artist: data.error?.error_message || 'TRY AGAIN', timestamp: '' });
        }
      } catch (err) {
        console.error('[SHAZAM] AudD request failed:', err);
        setShazamResult({ id: 'error', title: 'NETWORK ERROR', artist: 'CHECK CONNECTION', timestamp: '' });
      }
      setIsShazamScanning(false);
    };

    mediaRecorder.start();
    setTimeout(() => { mediaRecorder.stop(); }, 8000);
  };

  const handleSaveAuddToken = () => {
    const token = auddTokenInput.trim();
    if (token.length > 5) {
      setAuddToken(token);
      localStorage.setItem('AUDD_API_TOKEN', token);
      setAuddTokenInput('');
    }
  };

  // --- SOCIAL & COMMUNITY ACTIONS ---
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginInput.trim()) return;
    
    // Check if user exists, else create new
    let user = userRegistry.find(u => u.name.toLowerCase() === loginInput.toLowerCase());
    if (!user) {
      user = {
        id: `u_${Date.now()}`,
        name: loginInput,
        genreVibe: [],
        stations: stations
      };
      const newRegistry = [...userRegistry, user];
      setUserRegistry(newRegistry);
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(newRegistry));
    }
    
    setCurrentUser(user);
    setStations(user.stations);
    localStorage.setItem(USER_SESSION_KEY, JSON.stringify(user));
    setLoginInput('');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem(USER_SESSION_KEY);
    setStations(DEFAULT_STATIONS);
  };

  const createSnapshot = () => {
    setBackupStations([...stations]);
    console.log("[COMMUNITY] Local memory snapshot created.");
  };

  const restoreSnapshot = () => {
    if (backupStations) {
      setStations(backupStations);
      setBackupStations(null);
      console.log("[COMMUNITY] Memory bank restored to last snapshot.");
    }
  };

  const importUserSetup = (targetUser: User) => {
    // Auto-snapshot current if not already done
    if (!backupStations) createSnapshot();
    
    setStations(targetUser.stations);
    console.log(`[COMMUNITY] Previewing setup from ${targetUser.name}`);
  };

  const getVibeTags = (userStations: Station[]) => {
    const tags = new Set<string>();
    userStations.forEach(s => {
      s.tags?.split(',').forEach(t => tags.add(t.trim().toUpperCase()));
    });
    return Array.from(tags).slice(0, 3);
  };

  const handleReset = () => {
    if (confirm('¿LIMPIAR TOTALMENTE LA MEMORIA DE LA RADIO?')) {
      localStorage.removeItem(STORAGE_KEY);
      setStations([]);
      console.warn("[STORAGE] Global memory purge executed.");
      window.location.reload();
    }
  };

  const allTags: string[] = Array.from(new Set(stations.flatMap(s => s.tags?.split(',').map(t => t.trim()) || []))).sort();

  const displayStations = [...stations]
    .filter(s => !filterTag || s.tags?.toLowerCase().includes(filterTag.toLowerCase()))
    .sort((a, b) => {
      if (viewMode === 'custom' || sortBy === 'freq') return a.frequency - b.frequency;
      return a.name.localeCompare(b.name);
    });

  const currentStation = stations.find(s => Math.abs(s.frequency - freq) < 0.4);

  return (
    <div className="app-layout">
      <div className="radio-container">
        <div className="radio-chassis">
          <div className="brand">ANTIGRAVITY R-800 RED PREMIUM</div>
          
          <div className="radio-faceplate">
            <div className="radio-display">
              <div className="freq-display">
                {freq.toFixed(1)}<span className="unit">MHz</span>
              </div>
              <div className="station-name marquee">
                {currentStation ? currentStation.name.toUpperCase() : "NO SIGNAL"}
              </div>
              <div className="metadata-container">
                <div className="metadata-label">
                  {currentMetadata}
                </div>
                <Visualizer engine={engineRef.current} isStarted={isStarted} />
              </div>
            </div>

            <div className="controls-section">
              <div className="knob-container">
                <div 
                  className="knob" 
                  style={{ transform: `rotate(${(freq - 88) * 10}deg)`, touchAction: 'none' }}
                  onMouseDown={(e) => {
                    const startX = e.clientX;
                    const startFreq = freq;
                    const handleMouseMove = (mmE: MouseEvent) => {
                      const diff = (mmE.clientX - startX) / 10;
                      const nextFreq = Math.max(88, Math.min(108, startFreq + diff));
                      setFreq(parseFloat(nextFreq.toFixed(1)));
                    };
                    const handleMouseUp = () => {
                      window.removeEventListener('mousemove', handleMouseMove);
                      window.removeEventListener('mouseup', handleMouseUp);
                    };
                    window.addEventListener('mousemove', handleMouseMove);
                    window.addEventListener('mouseup', handleMouseUp);
                  }}
                  onTouchStart={(e) => {
                    const startX = e.touches[0].clientX;
                    const startFreq = freq;
                    const handleTouchMove = (tmE: TouchEvent) => {
                      tmE.preventDefault();
                      const diff = (tmE.touches[0].clientX - startX) / 10;
                      const nextFreq = Math.max(88, Math.min(108, startFreq + diff));
                      setFreq(parseFloat(nextFreq.toFixed(1)));
                    };
                    const handleTouchEnd = () => {
                      window.removeEventListener('touchmove', handleTouchMove);
                      window.removeEventListener('touchend', handleTouchEnd);
                    };
                    window.addEventListener('touchmove', handleTouchMove, { passive: false });
                    window.addEventListener('touchend', handleTouchEnd);
                  }}
                >
                  <div className="knob-marker"></div>
                </div>
                <div className="label">TUNING</div>
              </div>
              
              <div className="power-group">
                <button 
                  className={`start-button ${isStarted ? 'on' : ''}`} 
                  onClick={handlePowerToggle}
                >
                  {isStarted ? 'POWER ON' : 'POWER OFF'}
                </button>
                
                <button 
                  className={`normalize-button ${isNormalized ? 'active' : ''}`}
                  onClick={toggleNormalization}
                >
                  NORMALIZER
                </button>

                <button className={`shazam-button ${isShazamOpen ? 'active' : ''}`} onClick={() => setIsShazamOpen(!isShazamOpen)} disabled={!isStarted}>
                  SHAZAM
                </button>

                {backupStations ? (
                  <button className="restore-setup-btn active-alarm" onClick={restoreSnapshot}>
                    RESTORE SETUP
                  </button>
                ) : (
                  <button className="lock-btn-disabled" disabled>
                    LOCKED
                  </button>
                )}
                
                <button 
                  className={`panel-toggle ${showAddPanel ? 'active' : ''}`} 
                  onClick={() => {
                    if (!showAddPanel) {
                      setNewStation(prev => ({ 
                        ...prev, 
                        frequency: isAutoFreq ? findAvailableFrequency(stations) : Number(freq.toFixed(1))
                      }));
                    }
                    setShowAddPanel(!showAddPanel);
                  }}
                >
                  {showAddPanel ? 'CONFIG CLOSE' : 'ADD STATION'}
                </button>
              </div>
            </div>

            <div className="dial-section">
              <div className="dial-backlight-overlay"></div>
              <div className="needle" style={{ left: `${((freq - 88) / 20) * 100}%` }}></div>
              <div className="dial-marks">
                {Array.from({ length: 11 }, (_, i) => 88 + i * 2).map(f => (
                  <div key={f} className="mark">
                    <div className="line"></div>
                    <span className="number">{f}</span>
                  </div>
                ))}
                {stations.map((s) => (
                  <div 
                    key={s.id} 
                    className={`station-marker ${Math.abs(s.frequency - freq) < 0.4 ? 'active' : ''}`} 
                    style={{ left: `${((s.frequency - 88) / 20) * 100}%` }}
                  >
                    <div className="marker-icon"></div>
                    <div className="marker-label">{s.name}</div>
                  </div>
                ))}
              </div>
              <input
                type="range"
                min="88.0"
                max="108.0"
                step="0.05"
                value={freq}
                onChange={(e) => setFreq(parseFloat(e.target.value))}
                className="frequency-input"
              />
            </div>
          </div>

          {showAddPanel && (
            <div className="add-panel glass-panel">
              <div className="panel-header">
                <h3>STATION CONFIGURATION</h3>
                <button className="close-btn" onClick={() => setShowAddPanel(false)}>×</button>
              </div>
              
              <div className="search-box">
                <label>GLOBAL DIRECTORY SEARCH</label>
                <div className="search-input-group">
                  <input 
                    value={searchQuery} 
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    placeholder="Enter name or genre..."
                  />
                  <button onClick={handleSearch} disabled={isSearching}>
                    {isSearching ? '...' : 'SCAN'}
                  </button>
                </div>
                
                {searchResults.length > 0 && (
                  <div className="search-results">
                    {searchResults.map((item, idx) => (
                      <div key={idx} className="search-item" onClick={() => selectSearchResult(item)}>
                        <div className="item-name">{item.name}</div>
                        <div className="item-meta">{item.country} • {item.tags}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <hr className="panel-divider" />

              <form onSubmit={handleAddStation} className="add-form">
                <div className="field">
                  <label>STATION NAME</label>
                  <input 
                    required 
                    value={newStation.name} 
                    onChange={e => setNewStation({...newStation, name: e.target.value})}
                    placeholder="e.g., Radio Nova"
                  />
                </div>
                <div className="field">
                  <div className="field-header">
                    <div className="field-info">
                      <label>TUNING BAND</label>
                      <div className="mode-selector">
                        <div className={`mode-indicator ${isAutoFreq ? 'auto' : 'manual'}`}></div>
                        <button 
                          type="button" 
                          onClick={() => {
                            setIsAutoFreq(true);
                            const targetFreq = findAvailableFrequency(stations);
                            let count = newStation.frequency;
                            const step = (targetFreq - count) / 10;
                            const interval = setInterval(() => {
                              count += step;
                              if (Math.abs(count - targetFreq) < 0.1) {
                                setNewStation(prev => ({ ...prev, frequency: targetFreq }));
                                clearInterval(interval);
                              } else {
                                setNewStation(prev => ({ ...prev, frequency: parseFloat(count.toFixed(1)) }));
                              }
                            }, 30);
                          }}
                        >
                          AUTO
                        </button>
                        <button type="button" onClick={() => setIsAutoFreq(false)}>
                          MANUAL
                        </button>
                      </div>
                    </div>
                    <div className="mini-freq-lcd">
                      {newStation.frequency.toFixed(1)}<span className="unit-mini">MHz</span>
                    </div>
                  </div>
                  
                  <div className={`mini-tuner ${isAutoFreq ? 'locked' : ''}`}>
                    <div className="mini-dial">
                      {stations.map((s) => (
                        <div 
                          key={s.id} 
                          className="mini-marker" 
                          style={{ left: `${((s.frequency - 88) / 20) * 100}%` }}
                        ></div>
                      ))}
                      <div className="mini-needle" style={{ left: `${((newStation.frequency - 88) / 20) * 100}%` }}></div>
                    </div>
                    {!isAutoFreq && (
                      <input 
                        type="range" 
                        step="0.1" min="88" max="108" required 
                        value={newStation.frequency} 
                        onChange={e => setNewStation({...newStation, frequency: parseFloat(e.target.value)})}
                        className="mini-input"
                      />
                    )}
                    {isAutoFreq && <div className="auto-label">CLEAR RANGE CALIBRATED</div>}
                  </div>
                </div>
                <div className="field">
                  <label>STREAM SOURCE URL</label>
                  <input 
                    type="url" required 
                    value={newStation.url} 
                    onChange={e => setNewStation({...newStation, url: e.target.value})}
                    placeholder="https://server.com/live"
                  />
                </div>
                <div className="form-actions">
                  <button type="submit" className="add-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'STORING...' : 'COMMIT TO MEMORY'}
                  </button>
                  <button type="button" onClick={handleReset} className="reset-btn">PURGE SYSTEM</button>
                </div>
              </form>
            </div>
          )}

          <div className="stations-footer">
            <div className="footer-header">
              <div className="footer-label">STORED FREQUENCIES</div>
              <div className="view-switcher">
                <div className={`view-indicator ${viewMode === 'custom' ? 'dial' : 'list'}`}></div>
                <button onClick={() => { setViewMode('custom'); setFilterTag(''); }}>
                  DIAL
                </button>
                <button onClick={() => setViewMode('filtered')}>
                  LIST
                </button>
              </div>
            </div>

            {viewMode === 'filtered' && (
              <div className="filter-controls">
                <select value={filterTag} onChange={e => setFilterTag(e.target.value)} className="tag-select">
                  <option value="">ALL GENRES</option>
                  {allTags.map(tag => (
                    <option key={tag} value={tag}>{tag.toUpperCase()}</option>
                  ))}
                </select>
                <div className="sort-group">
                  <button className={sortBy === 'freq' ? 'active' : ''} onClick={() => setSortBy('freq')}>FREQ</button>
                  <button className={sortBy === 'name' ? 'active' : ''} onClick={() => setSortBy('name')}>NAME</button>
                </div>
              </div>
            )}

            <div className="stations-grid">
              {displayStations.map((s, idx) => (
                <div 
                  key={s.id} 
                  className={`station-card ${Math.abs(s.frequency - freq) < 0.4 ? 'active' : ''} ${draggedIndex === idx ? 'dragging' : ''}`} 
                  onClick={() => setFreq(s.frequency)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(idx)}
                >
                  {stationToDelete === s.id ? (
                    <div className="purge-overlay" onPointerDown={e => e.stopPropagation()}>
                      <div className="purge-prompt">PURGE?</div>
                      <div className="purge-actions">
                        <button className="purge-confirm" onPointerDown={(e) => handleConfirmDelete(e, s.id)}>Y</button>
                        <button className="purge-cancel" onPointerDown={handleCancelDelete}>N</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="drag-handle">⋮⋮</div>
                      <div 
                        className="delete-wrapper"
                        onPointerDown={(e) => handleDeleteInit(e, s.id)}
                        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        draggable="false"
                      >
                        <button 
                          className="delete-station-btn" 
                          onPointerDown={(e) => handleDeleteInit(e, s.id)}
                          draggable="false"
                        >
                          ×
                        </button>
                      </div>
                      <div className="card-freq">{s.frequency.toFixed(1)}</div>
                      <div className="card-name">{s.name}</div>
                      {s.tags && <div className="card-tags">{s.tags.split(',')[0]}</div>}
                    </>
                  )}
                </div>
              ))}
              {displayStations.length === 0 && (
                <div className="empty-message">NO STATIONS STORED.</div>
              )}
            </div>
          </div>
        </div>

        {isShazamOpen && (
          <div className="shazam-panel">
            <div className="shazam-header">
              <div className="shazam-title">SHAZAM DISCOVERY</div>
              <button className="shazam-close" onClick={() => setIsShazamOpen(false)}>×</button>
            </div>
            
            <div className="shazam-body">
              {!isShazamLoggedIn ? (
                <div className="shazam-login">
                  <div className="shazam-icon-static">♪</div>
                  <h3>AUDD API TOKEN</h3>
                  <p>Get your free token at <a href="https://dashboard.audd.io" target="_blank" rel="noopener" style={{color:'#f00'}}>dashboard.audd.io</a></p>
                  <div className="audd-token-input">
                    <input 
                      type="text"
                      value={auddTokenInput}
                      onChange={(e) => setAuddTokenInput(e.target.value)}
                      placeholder="Paste API token here..."
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveAuddToken()}
                    />
                    <button 
                      className="shazam-login-btn" 
                      onClick={handleSaveAuddToken}
                      disabled={auddTokenInput.trim().length < 5}
                    >
                      ACTIVATE
                    </button>
                  </div>
                </div>
              ) : isShazamScanning ? (
                <div className={`shazam-scanning ${isShazamListening ? 'listening' : ''}`}>
                  <div className="shazam-radar"></div>
                  <div className="shazam-status">
                    {isShazamListening ? 'ESCUCHANDO AUDIO...' : 'PROCESANDO SEÑAL...'}
                  </div>
                </div>
              ) : shazamResult ? (
                <div className="shazam-result">
                  {shazamResult.albumArt && <img src={shazamResult.albumArt} alt="album" className="result-album-art" />}
                  <div className="result-label">{shazamResult.id === 'error' ? 'STATUS:' : 'FOUND ON AIR:'}</div>
                  <div className="result-title">{shazamResult.title}</div>
                  <div className="result-artist">{shazamResult.artist}</div>
                  {shazamResult.album && <div className="result-album">{shazamResult.album}</div>}
                  <div className="result-links">
                    {shazamResult.spotifyUrl && <a href={shazamResult.spotifyUrl} target="_blank" rel="noopener" className="result-link spotify">SPOTIFY</a>}
                    {shazamResult.appleMusicUrl && <a href={shazamResult.appleMusicUrl} target="_blank" rel="noopener" className="result-link apple">APPLE MUSIC</a>}
                  </div>
                  <button className="shazam-scan-btn retry" onClick={handleShazamAction}>SCAN AGAIN</button>
                </div>
              ) : (
                <div className="shazam-ready">
                  <div className="shazam-icon-glow" onClick={handleShazamAction}>S</div>
                  <p>Toca para identificar</p>
                  <button className="shazam-scan-btn" onClick={handleShazamAction}>TAP TO SHAZAM</button>
                  
                  {currentUser && currentUser.shazamHistory && currentUser.shazamHistory.length > 0 && (
                    <div className="shazam-history">
                      <div className="history-label">RECENT IDENTIFICATIONS</div>
                      <div className="history-list">
                        {currentUser.shazamHistory.map(track => (
                          <div key={track.id} className="history-item">
                            <div className="item-info">
                              <div className="item-title">{track.title}</div>
                              <div className="item-artist">{track.artist}</div>
                            </div>
                            <div className="item-time">{track.timestamp}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!currentUser && (
          <div className="login-overlay">
            <div className="login-box">
              <div className="brand">ANTIGRAVITY R-800</div>
              <h2>OPERATOR LOGIN</h2>
              <p>Identify yourself to access your frequency bank.</p>
              <form onSubmit={handleLogin}>
                <input 
                  type="text" 
                  placeholder="ENTER OPERATOR NAME..." 
                  value={loginInput}
                  onChange={(e) => setLoginInput(e.target.value)}
                  autoFocus
                />
                <button type="submit">INITIALIZE SYSTEM</button>
              </form>
            </div>
          </div>
        )}

        {currentUser && (
          <div className="user-status-bar">
            <span>OPERATOR: <strong>{currentUser.name.toUpperCase()}</strong></span>
            <button onClick={handleLogout}>LOGOUT</button>
          </div>
        )}
      </div>

      {currentUser && (
        <aside className="community-sidebar">
          <div className="sidebar-header">STATION NETWORK</div>
          <div className="user-list">
            {userRegistry.filter(u => u.name !== currentUser.name).map(u => (
              <div 
                key={u.id} 
                className={`sidebar-user-card ${stations === u.stations ? 'active' : ''}`} 
                onClick={() => importUserSetup(u)}
              >
                <div className="user-avatar-container">
                  <div className="user-avatar">{u.name[0].toUpperCase()}</div>
                  <div className="status-dot"></div>
                </div>
                <div className="user-details">
                  <div className="user-name">{u.name.toUpperCase()}</div>
                  <div className="user-vibe">
                    {getVibeTags(u.stations).map(tag => (
                      <span key={tag} className="vibe-tag">{tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
};

export default App;
