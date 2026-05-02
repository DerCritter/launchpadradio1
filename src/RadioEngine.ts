export interface Station {
  id: string;
  name: string;
  url: string;
  frequency: number; 
  tags?: string;
}

interface StationState {
  audio: HTMLAudioElement;
  gainNode: GainNode | null;
  source: MediaElementAudioSourceNode | null;
  isCorsBlocked: boolean;
}

export class RadioEngine {
  private audioCtx: AudioContext | null = null;
  private stations: Map<string, StationState> = new Map();
  private noiseGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private isNormalized: boolean = false;
  private analyser: AnalyserNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private dataArray: Uint8Array | null = null;

  constructor(private stationsList: Station[]) { }

  async init() {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    this.masterGain = this.audioCtx.createGain();
    
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.8;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    
    // Internal recordable stream for Shazam capture
    this.streamDest = this.audioCtx.createMediaStreamDestination();
    this.analyser.connect(this.streamDest);

    this.compressor = this.audioCtx.createDynamicsCompressor();
    this.compressor.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
    this.compressor.knee.setValueAtTime(40, this.audioCtx.currentTime);
    this.compressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);
    this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
    this.compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);
    this.compressor.connect(this.masterGain);

    this.noiseGain = this.audioCtx.createGain();
    this.noiseGain.connect(this.isNormalized ? this.compressor : this.masterGain);
    this.setupNoise();

    for (const station of this.stationsList) {
      this.initStation(station);
    }
  }

  setNormalization(enabled: boolean) {
    this.isNormalized = enabled;
    if (!this.audioCtx || !this.compressor || !this.masterGain || !this.noiseGain) return;

    this.noiseGain.disconnect();
    this.noiseGain.connect(enabled ? this.compressor : this.masterGain);

    this.stations.forEach(state => {
      if (state.gainNode) {
        state.gainNode.disconnect();
        state.gainNode.connect(enabled ? this.compressor! : this.masterGain!);
      }
    });
  }

  private initStation(station: Station) {
    if (!this.audioCtx) return;
    
    const id = station.id || station.name;
    const existing = this.stations.get(id);
    if (existing) {
      existing.audio.pause();
      existing.audio.src = "";
    }

    // --- Phase 1: Try with CORS (enables Web Audio graph routing) ---
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.src = station.url;
    // Live streams are infinite — never set loop
    audio.volume = 0;
    
    let gainNode: GainNode | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let isCorsBlocked = false;
    let corsResolved = false;

    const destination = this.isNormalized ? this.compressor! : this.masterGain!;

    try {
      gainNode = this.audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
      gainNode.connect(destination);
      
      source = this.audioCtx.createMediaElementSource(audio);
      source.connect(gainNode);
    } catch (e) {
      console.warn(`[ENGINE] Failed to create source node for ${station.name}:`, e);
    }

    // --- Phase 2: CORS validation via events ---
    // If audio data actually starts flowing, CORS is fine
    const onSuccess = () => {
      if (corsResolved) return;
      corsResolved = true;
      console.log(`[ENGINE] ✓ ${station.name} — CORS OK, Web Audio routed.`);
      cleanup();
    };

    // If the audio element errors, switch to fallback
    const onError = () => {
      if (corsResolved) return;
      corsResolved = true;
      console.warn(`[ENGINE] ✗ ${station.name} — CORS blocked or network error, switching to direct.`);
      cleanup();
      switchToDirectPlayback();
    };

    // Safety timeout — some streams just hang without erroring
    const corsTimer = setTimeout(() => {
      if (!corsResolved && (audio.readyState < 2 || audio.networkState === 3)) {
        console.warn(`[ENGINE] ⏱ ${station.name} — Timeout, assuming CORS block.`);
        onError();
      }
    }, 4000);

    const cleanup = () => {
      clearTimeout(corsTimer);
      audio.removeEventListener('canplaythrough', onSuccess);
      audio.removeEventListener('playing', onSuccess);
      audio.removeEventListener('error', onError);
    };

    const switchToDirectPlayback = () => {
      isCorsBlocked = true;

      // Disconnect old nodes (they're tainted)
      if (gainNode) { try { gainNode.disconnect(); } catch(e){} }
      if (source) { try { source.disconnect(); } catch(e){} }
      gainNode = null;
      source = null;

      // Create a completely fresh audio element without crossOrigin
      const freshAudio = new Audio();
      freshAudio.preload = "auto";
      freshAudio.src = station.url;
      freshAudio.volume = 0;

      // Update the station state with the fresh element
      const state = this.stations.get(id);
      if (state) {
        state.audio = freshAudio;
        state.gainNode = null;
        state.source = null;
        state.isCorsBlocked = true;
      }

      if (this.audioCtx?.state === 'running') {
        freshAudio.play().catch(() => {});
      }
    };

    audio.addEventListener('canplaythrough', onSuccess);
    audio.addEventListener('playing', onSuccess);
    audio.addEventListener('error', onError);

    // Save state immediately so tuning can reference it
    this.stations.set(id, { 
      audio,
      gainNode,
      source,
      isCorsBlocked
    });
    
    if (this.audioCtx.state === 'running') {
      audio.play().catch(() => {});
    }
  }

  addStation(station: Station) {
    const id = station.id || station.name;
    const url = (station.url || "").trim().replace(/\/$/, "").toLowerCase();
    
    if (this.stations.has(id)) return;
    if (this.stationsList.some(s => (s.url || "").trim().replace(/\/$/, "").toLowerCase() === url)) {
      console.warn(`Station with URL ${url} already exists in engine.`);
      return;
    }

    this.stationsList.push(station);
    if (this.audioCtx) this.initStation(station);
  }

  updateStationsPool(newList: Station[]) {
    this.stationsList = [...newList];
    newList.forEach(s => {
      const id = s.id || s.name;
      if (!this.stations.has(id)) {
        if (this.audioCtx) this.initStation(s);
      }
    });
    console.log(`[ENGINE] Pool synchronized. ${this.stationsList.length} stations in memory.`);
  }

  removeStation(id: string) {
    const state = this.stations.get(id);
    if (state) {
      state.audio.pause();
      state.audio.src = "";
      state.audio.load();
      if (state.gainNode) { try { state.gainNode.disconnect(); } catch(e){} }
      if (state.source) { try { state.source.disconnect(); } catch(e){} }
      this.stations.delete(id);
    }
    this.stationsList = this.stationsList.filter(s => (s.id || s.name) !== id);
  }

  private setupNoise() {
    if (!this.audioCtx) return;
    const bufferSize = 2 * this.audioCtx.sampleRate;
    const noiseBuffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = this.audioCtx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;
    whiteNoise.start(0);

    whiteNoise.connect(this.noiseGain!);
  }

  updateTuning(currentFreq: number) {
    if (!this.audioCtx) return;

    let maxStationGain = 0;

    this.stationsList.forEach(station => {
      const id = station.id || station.name;
      const state = this.stations.get(id);
      if (state) {
        const dist = Math.abs(currentFreq - station.frequency);
        const bandwidth = 0.45; 
        const gain = Math.exp(-(dist * dist) / (2 * bandwidth * bandwidth));
        
        const finalGain = Math.max(0, Math.min(1, gain));
        
        if (state.gainNode && !state.isCorsBlocked) {
          state.gainNode.gain.setTargetAtTime(finalGain, this.audioCtx!.currentTime, 0.05);
          state.audio.volume = 1;
        } else {
          // Fallback for CORS blocked streams — direct volume
          state.audio.volume = finalGain;
        }
        
        if (gain > 0.001) {
          if (state.audio.paused) {
            state.audio.play().catch(() => {});
          }
        }
        
        maxStationGain = Math.max(maxStationGain, gain);
      }
    });

    const staticGain = Math.max(0, 1 - maxStationGain * 1.8);
    this.noiseGain?.gain.setTargetAtTime(staticGain * 0.15, this.audioCtx.currentTime, 0.05);
  }

  resume() {
    this.audioCtx?.resume();
    this.stations.forEach(state => {
      state.audio.play().catch(() => {});
    });
  }

  stop() {
    this.audioCtx?.suspend();
    this.stations.forEach(state => {
      state.audio.pause();
    });
  }

  getVisualizerData(): Uint8Array | null {
    if (!this.analyser || !this.dataArray || this.audioCtx?.state !== 'running') return null;
    this.analyser.getByteFrequencyData(this.dataArray as any);
    return this.dataArray;
  }

  getStream(): MediaStream | null {
    return this.streamDest?.stream || null;
  }
}
