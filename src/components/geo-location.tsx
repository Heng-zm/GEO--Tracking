"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, Loader2,
  Trash2, Crosshair, Compass as CompassIcon, WifiOff,
  Maximize2, X, LocateFixed, Circle, Download, Sunrise, Sunset, Moon, Wind,
  Share2, Signal, Plus, Minus, Copy, Check, Layers, Scan,
  ArrowUp, Hand, Video, VideoOff, Aperture, Upload, Target, EyeOff,
  Headphones, Mic, Volume2, Globe, Box, Eye
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- TensorFlow & Webcam ---
import Webcam from "react-webcam";
import * as tf from "@tensorflow/tfjs";
import * as handpose from "@tensorflow-models/handpose";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import '@tensorflow/tfjs-backend-webgl';

// --- Mapbox GL JS ---
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// --- Configuration ---
const MAPBOX_TOKEN = "pk.eyJ1Ijoib3BlbnN0cmVldGNhbSIsImEiOiJja252Ymh4ZnIwNHdkMnd0ZzF5NDVmdnR5In0.dYxz3TzZPTPzd_ibMeGK2g";
mapboxgl.accessToken = MAPBOX_TOKEN;

const RADAR_ZOOM = 16; // Reduced slightly to ensure static tile availability
const TRAIL_MAX_POINTS = 100; 
const TRAIL_MIN_DISTANCE = 5; 
const MAP_UPDATE_THRESHOLD = 80; 
const REC_MIN_DISTANCE = 5; 
const GPS_HEADING_THRESHOLD = 1.0; 

// --- Constants ---
const COMPASS_TICKS = [...Array(72)].map((_, i) => i);
const PITCH_LADDER_LINES = [-60, -50, -40, -30, -20, -10, 10, 20, 30, 40, 50, 60];
const BANKING_SCALE_TICKS = [-30, -20, -10, 10, 20, 30];

// --- Types ---
type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
};

type GeoState = {
  coords: Coordinates | null;
  error: string | null;
  loading: boolean;
};

type WeatherData = {
  temp: number;
  code: number;
  description: string;
  windSpeed: number;
  windDir: number;
  sunrise: string[];
  sunset: string[];
};

type GeoPoint = { lat: number; lng: number; alt: number | null; timestamp: number };
type UnitSystem = 'metric' | 'imperial';
type MapMode = '2d' | '3d';
type NorthRef = 'heading-up' | 'north-up';

interface TargetData {
    lat: number;
    lng: number;
    active: boolean;
}

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const triggerHaptic = () => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(15);
  }
};

const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(6)}°${direction}`;
};

const convertSpeed = (ms: number | null, system: UnitSystem): string => {
  if (ms === null || ms < 0) return "0.0";
  return system === 'metric' ? `${(ms * 3.6).toFixed(1)}` : `${(ms * 2.23694).toFixed(1)}`;
};

const convertAltitude = (meters: number | null, system: UnitSystem): string => {
  if (meters === null) return "--";
  return system === 'metric' ? `${Math.round(meters)}` : `${Math.round(meters * 3.28084)}`;
};

const convertTemp = (celsius: number, system: UnitSystem): string => {
  return system === 'metric' ? `${celsius.toFixed(1)}°` : `${((celsius * 9/5) + 32).toFixed(1)}°`;
};

const convertDistance = (meters: number, system: UnitSystem): string => {
    if (system === 'metric') {
        return meters >= 1000 ? `${(meters/1000).toFixed(2)}km` : `${Math.round(meters)}m`;
    }
    const feet = meters * 3.28084;
    return feet >= 5280 ? `${(feet/5280).toFixed(2)}mi` : `${Math.round(feet)}ft`;
};

const getWeatherInfo = (code: number) => {
  if (code === 0) return { label: "Clear", icon: Sun };
  if (code <= 3) return { label: "Cloudy", icon: CloudSun };
  if (code <= 48) return { label: "Fog", icon: CloudFog };
  if (code <= 67) return { label: "Rain", icon: CloudRain };
  if (code <= 77) return { label: "Snow", icon: Snowflake };
  if (code <= 82) return { label: "H. Rain", icon: CloudRain };
  if (code >= 95) return { label: "Storm", icon: CloudLightning };
  return { label: "Overcast", icon: Cloud };
};

const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3; 
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getBearing = (startLat: number, startLng: number, destLat: number, destLng: number) => {
    const startLatRad = startLat * (Math.PI / 180);
    const startLngRad = startLng * (Math.PI / 180);
    const destLatRad = destLat * (Math.PI / 180);
    const destLngRad = destLng * (Math.PI / 180);

    const y = Math.sin(destLngRad - startLngRad) * Math.cos(destLatRad);
    const x = Math.cos(startLatRad) * Math.sin(destLatRad) -
              Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(destLngRad - startLngRad);
    let brng = Math.atan2(y, x);
    brng = brng * (180 / Math.PI);
    return (brng + 360) % 360;
};

const geoToPixels = (lat: number, lng: number, anchorLat: number, anchorLng: number, zoom: number) => {
  const TILE_SIZE = 512; 
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const project = (lat: number, lng: number) => {
    let siny = Math.sin((lat * Math.PI) / 180);
    siny = Math.min(Math.max(siny, -0.9999), 0.9999);
    return {
      x: worldSize * (0.5 + lng / 360),
      y: worldSize * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI))
    };
  };
  const point = project(lat, lng);
  const anchor = project(anchorLat, anchorLng);
  return { x: point.x - anchor.x, y: point.y - anchor.y };
};

const generateGPX = (points: GeoPoint[]) => {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FieldNavApp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Mission Log ${new Date().toISOString()}</name>
    <trkseg>`;
  const footer = `
    </trkseg>
  </trk>
</gpx>`;
  const body = points.map(p => `
      <trkpt lat="${p.lat}" lon="${p.lng}">
        ${p.alt !== null ? `<ele>${p.alt.toFixed(2)}</ele>` : ''}
        <time>${new Date(p.timestamp).toISOString()}</time>
      </trkpt>`).join('');
  return header + body + footer;
};

const speak = (text: string) => {
    if(typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.1; u.pitch = 0.9;
    window.speechSynthesis.speak(u);
};

// --- Hooks ---
const useWakeLock = () => {
  useEffect(() => {
    if(typeof window === 'undefined') return;
    const request = async () => { try { if ('wakeLock' in navigator) await (navigator as any).wakeLock.request('screen'); } catch(e){} };
    request();
    const handleVis = () => document.visibilityState === 'visible' && request();
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, []);
};

const useGeolocation = () => {
  const [state, setState] = useState<GeoState>({ coords: null, error: null, loading: true });
  
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setState({ coords: null, loading: false, error: "Not Supported" });
      return;
    }
    const id = navigator.geolocation.watchPosition(
      ({ coords }) => {
        // Simple smoothing could go here, but raw data is preferred for tactical apps
        setState({
            coords: {
              latitude: coords.latitude,
              longitude: coords.longitude,
              accuracy: coords.accuracy,
              altitude: coords.altitude,
              speed: coords.speed,
              heading: coords.heading,
            }, 
            error: null, 
            loading: false,
        });
      }, 
      (error) => {
        if (error.code !== error.TIMEOUT) setState(s => ({ ...s, loading: false, error: "Signal Lost" }));
      }, 
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return state;
};

const useCompass = () => {
  const [headingState, setHeadingState] = useState({ heading: 0, trueHeading: 0, pitch: 0, roll: 0 });
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const refs = useRef({
      targetHeading: 0,
      currentHeading: 0,
      targetPitch: 0,
      currentPitch: 0,
      targetRoll: 0,
      currentRoll: 0
  });

  const requestAccess = useCallback(async () => {
    triggerHaptic();
    if (typeof DeviceOrientationEvent === 'undefined') { setError("No Sensor"); return; }
    
    // Check if permission is needed (iOS 13+)
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') { setPermissionGranted(true); setError(null); } 
        else { setError("Denied"); }
      } catch (e) { setError("Error"); }
    } else { 
        setPermissionGranted(true); 
    }
  }, []);

  useEffect(() => {
    if (!permissionGranted || typeof window === 'undefined') return;
    
    let rafId: number;
    let lastTime = 0;

    const loop = (time: number) => {
      // Throttle React State updates to ~30fps to save battery, but keep math internal
      if (time - lastTime > 32) { 
          const r = refs.current;
          let hDiff = r.targetHeading - r.currentHeading;
          if (hDiff > 180) hDiff -= 360;
          if (hDiff < -180) hDiff += 360;
          
          // Easing
          r.currentHeading += hDiff * 0.15;
          r.currentPitch += (r.targetPitch - r.currentPitch) * 0.1;
          r.currentRoll += (r.targetRoll - r.currentRoll) * 0.1;

          setHeadingState({
              heading: (r.currentHeading + 360) % 360,
              trueHeading: (r.targetHeading + 360) % 360,
              pitch: r.currentPitch,
              roll: r.currentRoll
          });
          lastTime = time;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const handleOrientation = (e: any) => {
      let degree: number | null = null;
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
          degree = e.webkitCompassHeading;
      } else if (e.alpha !== null) {
          degree = Math.abs(360 - e.alpha);
      }

      if (degree !== null) { refs.current.targetHeading = degree; }
      if (e.beta !== null) refs.current.targetPitch = e.beta;
      if (e.gamma !== null) refs.current.targetRoll = e.gamma;
    };

    // 'deviceorientationabsolute' is standard for Android for true north, 'deviceorientation' for iOS
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handleOrientation, true);
    
    return () => {
        window.removeEventListener(eventName, handleOrientation, true);
        cancelAnimationFrame(rafId);
    };
  }, [permissionGranted]);

  return { ...headingState, requestAccess, permissionGranted, error };
};

// --- GESTURE COMPONENT ---
const GestureOps = memo(({ onToggleRecording, onToggleMapMode, isRecording }: { onToggleRecording: () => void, onToggleMapMode: () => void, isRecording: boolean }) => {
  const webcamRef = useRef<Webcam>(null);
  const [model, setModel] = useState<handpose.HandPose | null>(null);
  const [loading, setLoading] = useState(true);
  const [gestureState, setGestureState] = useState<'neutral' | 'pinch' | 'fist'>('neutral');
  const [debugMsg, setDebugMsg] = useState("AI Init...");
  
  useEffect(() => {
    let active = true;
    const initTF = async () => {
      try {
        await tf.ready();
        await tf.setBackend('webgl');
        const net = await handpose.load();
        if (active) { setModel(net); setLoading(false); setDebugMsg("Ops Ready"); }
      } catch (e) {
        if (active) setDebugMsg("AI Error");
      }
    };
    initTF();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!model) return;
    let rafId: number;
    let lastActionTime = 0;
    let consecutivePinchFrames = 0;
    let consecutiveFistFrames = 0;
    const FRAMES_TO_TRIGGER = 3; 
    const ACTION_COOLDOWN = 1200; 

    const loop = async () => {
      if (webcamRef.current && webcamRef.current.video && webcamRef.current.video.readyState === 4) {
        const video = webcamRef.current.video;
        const hands = await model.estimateHands(video);

        if (hands.length > 0) {
            const landmarks = hands[0].landmarks;
            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            const pinchDist = Math.sqrt(Math.pow(thumbTip[0] - indexTip[0], 2) + Math.pow(thumbTip[1] - indexTip[1], 2));
            const pinkyTip = landmarks[20];
            const fistDist = Math.sqrt(Math.pow(thumbTip[0] - pinkyTip[0], 2) + Math.pow(thumbTip[1] - pinkyTip[1], 2));
            const now = Date.now();

            if (pinchDist < 25) {
                consecutivePinchFrames++;
                consecutiveFistFrames = 0;
                setGestureState('pinch');
                if (consecutivePinchFrames >= FRAMES_TO_TRIGGER && now - lastActionTime > ACTION_COOLDOWN) {
                    triggerHaptic();
                    onToggleMapMode();
                    setDebugMsg("Map Toggled");
                    lastActionTime = now;
                    consecutivePinchFrames = 0;
                }
            } else if (fistDist < 30) {
                consecutiveFistFrames++;
                consecutivePinchFrames = 0;
                setGestureState('fist');
                if (consecutiveFistFrames >= FRAMES_TO_TRIGGER && now - lastActionTime > ACTION_COOLDOWN) {
                    triggerHaptic();
                    onToggleRecording();
                    setDebugMsg(isRecording ? "Rec Stopped" : "Rec Started");
                    lastActionTime = now;
                    consecutiveFistFrames = 0;
                }
            } else {
                consecutivePinchFrames = 0;
                consecutiveFistFrames = 0;
                setGestureState('neutral');
                setDebugMsg("Scanning...");
            }
        } else {
            setGestureState('neutral');
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(rafId); };
  }, [model, onToggleRecording, onToggleMapMode, isRecording]);

  return (
    <div className="absolute top-20 right-4 w-28 h-36 bg-black/90 rounded-xl border border-green-500/30 overflow-hidden z-50 shadow-2xl backdrop-blur-md">
       <Webcam ref={webcamRef} className="absolute inset-0 w-full h-full object-cover opacity-50 grayscale" mirrored={true} videoConstraints={{ width: 160, height: 120, facingMode: "user" }} />
       <div className="absolute inset-0 flex flex-col items-center justify-between p-2 pointer-events-none">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-2"><Loader2 className="w-6 h-6 animate-spin text-green-500" /><span className="text-[8px] font-mono text-green-500/80 animate-pulse">BOOTING AI</span></div>
          ) : (
             <div className="mt-8 transition-all duration-200">
               {gestureState === 'neutral' && <Hand className="w-8 h-8 text-white/40" />}
               {gestureState === 'pinch' && <Scan className="w-8 h-8 text-green-400 animate-pulse" />}
               {gestureState === 'fist' && <Circle className="w-8 h-8 text-red-500 fill-red-500/50 animate-pulse" />}
             </div>
          )}
          {!loading && <div className="w-full bg-black/80 backdrop-blur-md rounded text-[8px] font-mono text-center py-1 text-green-400 border-t border-green-500/20">{debugMsg}</div>}
       </div>
    </div>
  );
});
GestureOps.displayName = "GestureOps";

// --- TACTICAL SCANNER ---
const TacticalScanner = memo(() => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [model, setModel] = useState<cocoSsd.ObjectDetection | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageFile, setImageFile] = useState<string | null>(null);
  const requestRef = useRef<number | null>(null);
  
  useEffect(() => {
    let active = true;
    tf.ready().then(() => tf.setBackend('webgl')).then(() => cocoSsd.load({ base: 'lite_mobilenet_v2' })).then(loaded => {
        if(active) { setModel(loaded); setLoading(false); }
    }).catch(e => console.warn("AI Load Error", e));
    return () => { active = false; };
  }, []);

  const detect = useCallback(async () => {
    if (!model || !canvasRef.current || (videoRef.current?.readyState !== 4 && !imageFile)) return;
    const src = imageFile ? document.getElementById('static-img') as HTMLImageElement : videoRef.current as HTMLVideoElement;
    if(!src) return;

    try {
        const predictions = await model.detect(src, 5, 0.5);
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            canvasRef.current.width = src.width || (src as HTMLVideoElement).videoWidth;
            canvasRef.current.height = src.height || (src as HTMLVideoElement).videoHeight;
            ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            ctx.font = '12px "Courier New"';
            ctx.lineWidth = 2;

            predictions.forEach(p => {
                const [x, y, w, h] = p.bbox;
                ctx.strokeStyle = '#22c55e';
                ctx.strokeRect(x, y, w, h);
                ctx.fillStyle = '#22c55e';
                const text = `${p.class.toUpperCase()} ${Math.round(p.score * 100)}%`;
                const tw = ctx.measureText(text).width;
                ctx.fillRect(x, y - 18, tw + 8, 18);
                ctx.fillStyle = '#000';
                ctx.fillText(text, x + 4, y - 5);
            });
        }
    } catch(e) {} 
    
    if(!imageFile) requestRef.current = requestAnimationFrame(detect);
  }, [model, imageFile]);

  useEffect(() => {
    if(model && !imageFile) requestRef.current = requestAnimationFrame(detect);
    return () => { if(requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [model, imageFile, detect]);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      if(e.target.files?.[0]) {
          setImageFile(URL.createObjectURL(e.target.files[0]));
          setTimeout(detect, 500); 
      }
  };

  return (
    <div className="absolute inset-0 z-50 bg-black flex flex-col">
        <div className="relative flex-1 w-full h-full bg-black/90 flex items-center justify-center overflow-hidden">
            {imageFile ? (
                <img id="static-img" src={imageFile} className="max-w-full max-h-full object-contain" onLoad={detect} alt="Target" />
            ) : (
                <Webcam ref={(r) => { if(r) videoRef.current = r.video; }} className="absolute inset-0 w-full h-full object-cover" videoConstraints={{ facingMode: "environment" }} muted />
            )}
            <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none w-full h-full object-contain" />
            {loading && <div className="absolute inset-0 flex items-center justify-center bg-black/80"><Loader2 className="w-10 h-10 text-green-500 animate-spin" /></div>}
            {!imageFile && (
                <div className="absolute inset-0 pointer-events-none opacity-30 flex items-center justify-center"><div className="w-64 h-64 border border-white/30 rounded-full flex items-center justify-center"><div className="w-1 h-2 bg-white/50" /></div><div className="absolute w-full h-px bg-white/10" /><div className="absolute h-full w-px bg-white/10" /></div>
            )}
        </div>
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-4 z-[60]">
            <label className="p-4 rounded-full bg-black/60 border border-green-500/50 text-green-500 backdrop-blur-md active:scale-95"><Upload className="w-6 h-6" /><input type="file" className="hidden" accept="image/*" onChange={handleUpload} /></label>
            {imageFile && <button onClick={() => { setImageFile(null); const ctx=canvasRef.current?.getContext('2d'); if(ctx) ctx.clearRect(0,0,1000,1000); }} className="p-4 rounded-full bg-red-900/50 border border-red-500 text-white"><Trash2 className="w-6 h-6" /></button>}
        </div>
    </div>
  );
});
TacticalScanner.displayName = "TacticalScanner";

// --- GHOST HUD (AR) ---
const GhostHUD = memo(({ heading, pitch, roll, targetBearing, targetDist }: { heading: number, pitch: number, roll: number, targetBearing: number | null, targetDist: string | null }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        let frameId: number;
        const ctx = canvas.getContext('2d');

        const render = () => {
            if (!ctx) return;
            const w = canvas.width = window.innerWidth;
            const h = canvas.height = window.innerHeight;
            const cx = w / 2;
            const cy = h / 2;
            
            // FOV Calculation: Mobile cameras usually have ~60 deg Horizontal FOV
            const FOV = 60;
            const pxPerDeg = w / FOV; 
            const pitchPxPerDeg = h / 60; // Approximate vertical scale

            ctx.clearRect(0, 0, w, h);
            ctx.save();
            
            // Horizon Line - Rotate the world based on Roll
            ctx.translate(cx, cy);
            ctx.rotate(-roll * Math.PI / 180);
            ctx.translate(0, pitch * pitchPxPerDeg); 
            
            // Horizon visuals
            ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
            ctx.fillRect(-w, 0, w*2, h*2); // Ground tint
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-w, 0); ctx.lineTo(w, 0);
            ctx.stroke();

            // Pitch Ladder
            ctx.font = '10px monospace';
            ctx.fillStyle = '#22c55e';
            ctx.textAlign = 'center';
            PITCH_LADDER_LINES.forEach(deg => {
                const y = -deg * pitchPxPerDeg;
                if (y > -h/2 - 100 && y < h/2 + 100) {
                    ctx.beginPath();
                    ctx.moveTo(-50, y); ctx.lineTo(50, y); 
                    ctx.moveTo(-50, y); ctx.lineTo(-50, y + (deg > 0 ? 5 : -5));
                    ctx.moveTo(50, y); ctx.lineTo(50, y + (deg > 0 ? 5 : -5));
                    ctx.stroke();
                    ctx.fillText(Math.abs(deg).toString(), -65, y + 4);
                    ctx.fillText(Math.abs(deg).toString(), 65, y + 4);
                }
            });

            ctx.restore();

            // Compass Strip (Top)
            ctx.save();
            const stripY = 60; // Padding from top
            
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(cx, stripY + 15); ctx.lineTo(cx - 6, stripY); ctx.lineTo(cx + 6, stripY);
            ctx.fill();

            ctx.strokeStyle = '#22c55e';
            ctx.fillStyle = '#22c55e';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';

            // Draw ~90 degrees of compass (FOV + buffer)
            const viewRange = FOV + 20; 
            for (let i = Math.floor(heading - viewRange/2); i <= heading + viewRange/2; i++) {
                const norm = ((i % 360) + 360) % 360;
                const x = cx + (i - heading) * pxPerDeg;
                
                if (norm % 10 === 0) {
                    ctx.beginPath(); ctx.moveTo(x, stripY); ctx.lineTo(x, stripY - 10); ctx.stroke();
                    let label = norm.toString();
                    if (norm === 0) label = "N"; if (norm === 90) label = "E"; if (norm === 180) label = "S"; if (norm === 270) label = "W";
                    ctx.fillText(label, x, stripY + 25);
                } else if (norm % 5 === 0) {
                    ctx.beginPath(); ctx.moveTo(x, stripY); ctx.lineTo(x, stripY - 5); ctx.stroke();
                }
            }

            // Target Marker AR
            if (targetBearing !== null) {
                let diff = targetBearing - heading;
                if (diff > 180) diff -= 360; 
                if (diff < -180) diff += 360;
                
                // If target is within screen width (FOV)
                if (Math.abs(diff) < (FOV / 2)) {
                    const tx = cx + (diff * pxPerDeg);
                    const ty = cy; // Center vertically for now (could use target Elevation if available)
                    
                    ctx.strokeStyle = '#3b82f6';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(tx - 25, ty - 25, 50, 50);
                    
                    // Crosshair inside box
                    ctx.beginPath(); ctx.moveTo(tx-5, ty); ctx.lineTo(tx+5, ty); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(tx, ty-5); ctx.lineTo(tx, ty+5); ctx.stroke();

                    ctx.fillStyle = '#3b82f6';
                    ctx.font = '10px monospace';
                    ctx.fillText(`TGT: ${targetDist}`, tx, ty + 40);
                } else {
                    // Arrow at edge of screen indicating direction
                    const edgeX = diff > 0 ? w - 20 : 20;
                    ctx.fillStyle = '#3b82f6';
                    ctx.beginPath();
                    ctx.moveTo(edgeX, cy); 
                    ctx.lineTo(edgeX + (diff>0?-10:10), cy - 10);
                    ctx.lineTo(edgeX + (diff>0?-10:10), cy + 10);
                    ctx.fill();
                    
                    ctx.textAlign = diff > 0 ? 'right' : 'left';
                    ctx.fillText(`TGT`, edgeX + (diff>0?-15:15), cy);
                }
            }
            ctx.restore();

            frameId = requestAnimationFrame(render);
        };
        render();
        return () => cancelAnimationFrame(frameId);
    }, [heading, pitch, roll, targetBearing, targetDist]);

    return <canvas ref={canvasRef} className="absolute inset-0 z-20 pointer-events-none" />;
});
GhostHUD.displayName = "GhostHUD";

// --- UI COMPONENTS ---
const Inclinometer = memo(({ pitch, roll }: { pitch: number, roll: number }) => (
    <div className="relative w-40 h-40 shrink-0 rounded-full border-[6px] border-[#1a1a1a] bg-[#0c0c0c] overflow-hidden shadow-2xl ring-1 ring-white/10 select-none">
       <div className="absolute inset-0 rounded-full border-2 border-white/5 z-30 pointer-events-none" />
       <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-1.5 bg-yellow-500 z-40" />
      <div className="absolute inset-[-50%] will-change-transform origin-center" style={{ transform: `rotate(${-roll}deg) translateY(${Math.max(Math.min(pitch, 60), -60) * 2}px)` }}>
        <div className="w-full h-1/2 bg-[#0066cc]/30 border-b-2 border-white/80" /> 
        <div className="w-full h-1/2 bg-[#663300]/40 border-t-2 border-white/80" /> 
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full">
            {PITCH_LADDER_LINES.map(deg => (
                <div key={deg} className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center gap-2 w-full opacity-60" style={{ top: `calc(50% - ${deg * 2}px)` }}>
                    <div className="h-px bg-white/80 w-6 shadow-[0_0_2px_black]" />
                </div>
            ))}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center z-20"><div className="w-1.5 h-1.5 bg-yellow-400 rounded-full border border-black/20" /><div className="absolute flex gap-8"><div className="w-8 h-1 bg-yellow-400/80 rounded-full" /><div className="w-8 h-1 bg-yellow-400/80 rounded-full" /></div></div>
      <div className="absolute top-2 inset-x-0 flex justify-center z-20">
           {BANKING_SCALE_TICKS.map(deg => <div key={deg} className="absolute top-0 h-2 w-px bg-white/40 origin-bottom" style={{ transform: `rotate(${deg}deg) translateY(2px)`, transformOrigin: 'center 68px' }} />)}
      </div>
      <div className="absolute bottom-3 inset-x-0 flex justify-between px-8 text-[7px] font-mono font-bold text-white/50 z-40">
        <span className="tabular-nums">{roll.toFixed(0)}°</span><span className="tabular-nums">{pitch.toFixed(0)}°</span>
      </div>
    </div>
));
Inclinometer.displayName = "Inclinometer";

const RadarMapbox = memo(({ path, heading, lat, lng, mode, accuracy, onRecenter, onToggleMode }: any) => {
  const [anchor, setAnchor] = useState({ lat, lng });
  const [isOffCenter, setIsOffCenter] = useState(false);
  const mapUrl = useMemo(() => `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${anchor.lng},${anchor.lat},${RADAR_ZOOM},0,0/600x600@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, [anchor]);

  useEffect(() => {
    const dist = getDistance(anchor.lat, anchor.lng, lat, lng);
    setIsOffCenter(dist > 30);
    if (dist > MAP_UPDATE_THRESHOLD) setAnchor({ lat, lng });
  }, [lat, lng, anchor]);

  const { userX, userY, svgPath } = useMemo(() => {
    const userPos = geoToPixels(lat, lng, anchor.lat, anchor.lng, RADAR_ZOOM);
    const points = path.slice(-50).map((p: any) => { 
        const pt = geoToPixels(p.lat, p.lng, anchor.lat, anchor.lng, RADAR_ZOOM);
        return `${pt.x},${pt.y}`;
    });
    return { userX: userPos.x, userY: userPos.y, svgPath: points.length > 1 ? "M " + points.join(" L ") : "" };
  }, [lat, lng, anchor, path]);

  const rotation = mode === 'heading-up' ? heading : 0;
  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-[#0c0c0c]">
      <div className="absolute inset-0 bg-black z-0">
          <div className="w-full h-full absolute inset-0 will-change-transform transition-transform duration-100 ease-linear origin-center" style={{ transform: `rotate(${-rotation}deg) scale(1.02)` }}>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[220%] h-[220%]"><img src={mapUrl} className="w-full h-full object-contain filter grayscale-[0.3] contrast-125 brightness-90" alt="" /></div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] pointer-events-none z-10">
              <svg viewBox="-200 -200 400 400" className="w-full h-full overflow-visible">
                {svgPath && <path d={svgPath} fill="none" stroke="#22c55e" strokeWidth="2.5" className="opacity-60" />}
                <g transform={`translate(${userX}, ${userY}) rotate(${mode === 'heading-up' ? 0 : heading})`}>
                   <path d="M -6 -6 L 0 -18 L 6 -6" fill="#22c55e" /><circle r="4" fill="#22c55e" className="animate-pulse" /><circle r="7" fill="none" stroke="#fff" strokeWidth="1.5" />
                </g>
              </svg>
            </div>
          </div>
      </div>
      <div className="absolute bottom-4 right-4 z-40 flex flex-col gap-2">
            <button onClick={onToggleMode} className={`p-3 rounded-full border transition-all bg-black/60 text-white backdrop-blur-md border-white/10`}>{mode === 'heading-up' ? <Navigation className="w-5 h-5"/> : <CompassIcon className="w-5 h-5"/>}</button>
             {isOffCenter && <button onClick={onRecenter} className="p-3 rounded-full text-blue-400 bg-black/60 border border-white/10"><Crosshair className="w-5 h-5" /></button>}
      </div>
    </div>
  );
});
RadarMapbox.displayName = "RadarMapbox";

const Mapbox3D = memo(({ path, lat, lng, heading, target }: any) => {
    const mapContainer = useRef<HTMLDivElement>(null);
    const map = useRef<mapboxgl.Map | null>(null);
    const marker = useRef<mapboxgl.Marker | null>(null);

    useEffect(() => {
        if (!mapContainer.current || map.current) return;
        
        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/satellite-streets-v12',
            center: [lng, lat],
            zoom: 17,
            pitch: 60, // 3D Tilt
            bearing: heading,
            attributionControl: false
        });

        map.current.on('load', () => {
             map.current?.addSource('mapbox-dem', { 'type': 'raster-dem', 'url': 'mapbox://mapbox.mapbox-terrain-dem-v1', 'tileSize': 512, 'maxzoom': 14 });
             map.current?.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 1.5 });
             map.current?.addLayer({ 'id': 'sky', 'type': 'sky', 'paint': { 'sky-type': 'atmosphere', 'sky-atmosphere-sun': [0.0, 0.0], 'sky-atmosphere-sun-intensity': 15 } });
        });

        const el = document.createElement('div');
        el.className = 'marker';
        el.innerHTML = '<div style="width:20px;height:20px;background:#22c55e;border:2px solid white;border-radius:50%;box-shadow:0 0 10px #22c55e;"></div>';
        marker.current = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map.current);

        return () => { 
            // Proper cleanup to prevent context loss on toggle
            map.current?.remove(); 
            map.current = null; 
        };
    }, []);

    useEffect(() => {
        if (!map.current) return;
        if(marker.current) marker.current.setLngLat([lng, lat]);
        map.current.easeTo({ center: [lng, lat], bearing: heading, duration: 1000 });
    }, [lat, lng, heading]);

    return <div ref={mapContainer} className="w-full h-full rounded-2xl overflow-hidden border border-white/10 shadow-2xl" />;
});
Mapbox3D.displayName = "Mapbox3D";

const CompassDisplay = memo(({ heading, trueHeading, onClick, hasError, permissionGranted, source, targetBearing }: any) => {
  const rotation = heading || 0;
  const displayHeading = trueHeading !== null ? Math.round(trueHeading) : 0;
  
  return (
    <div className="flex flex-col items-center justify-center relative z-10 shrink-0">
      <div className="relative w-64 h-64 md:w-72 md:h-72 cursor-pointer touch-manipulation transition-all duration-300" onClick={onClick}>
        <div className="absolute inset-0 rounded-full border-[10px] border-[#0c0c0c] bg-[#111] shadow-2xl flex items-center justify-center ring-1 ring-white/10">
             <div className="absolute top-1 text-[10px] font-black text-red-500">N</div>
             <div className="absolute right-2 text-[10px] font-black text-white/30">E</div>
             <div className="absolute bottom-2 text-[10px] font-black text-white/30">S</div>
             <div className="absolute left-2 text-[10px] font-black text-white/30">W</div>
             <div className="absolute top-0 -translate-y-1 w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-t-[10px] border-t-red-600 z-20" />
        </div>
        <div className="absolute inset-4 will-change-transform transition-transform duration-100 ease-linear rounded-full bg-[radial-gradient(circle,rgba(30,30,30,1)_0%,rgba(10,10,10,1)_100%)] border border-white/5" style={{ transform: `rotate(${-rotation}deg)` }}>
          <svg viewBox="0 0 100 100" className="w-full h-full p-1"><circle cx="50" cy="50" r="46" stroke="currentColor" strokeWidth="0.5" className="text-white/10 fill-none" />{COMPASS_TICKS.map((_, i) => <line key={i} x1="50" y1="5" x2="50" y2={i%6===0?8:6.5} transform={`rotate(${i*5} 50 50)`} stroke="currentColor" strokeWidth={i%18===0?1:0.5} className={i%18===0?"text-white":"text-white/30"} />)}</svg>
          {targetBearing !== null && (
              <div className="absolute inset-0 pointer-events-none" style={{ transform: `rotate(${targetBearing}deg)` }}>
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 w-3 h-3 bg-blue-500 border-2 border-white rotate-45 shadow-[0_0_10px_#3b82f6]" />
              </div>
          )}
        </div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center z-20 pointer-events-none">
             <span className="text-5xl font-mono font-black tracking-tighter text-white tabular-nums">{permissionGranted || source === 'GPS' ? `${displayHeading}°` : "--"}</span>
             <div className="flex items-center gap-1 mt-1"><span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase ${source === 'GPS' ? 'text-green-500 border-green-500/20' : 'text-blue-500 border-blue-500/20'}`}>{source}</span></div>
        </div>
        {!permissionGranted && !hasError && source === 'MAG' && <div className="absolute inset-0 flex items-center justify-center rounded-full z-30 bg-black/60 backdrop-blur-sm"><span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white animate-pulse border border-white/20 px-3 py-1 rounded-full"><CompassIcon className="w-3 h-3" /> Tap Align</span></div>}
      </div>
    </div>
  );
});
CompassDisplay.displayName = "CompassDisplay";

const StatCard = memo(({ icon: Icon, label, value, subValue, unit }: any) => (
  <div className="relative p-3 rounded-xl bg-[#111]/60 border border-white/5 backdrop-blur-md flex flex-col items-start justify-between min-w-[90px] h-full shadow-lg">
    <div className="flex w-full items-center justify-between mb-1 opacity-60"><span className="text-[9px] uppercase tracking-widest font-bold text-muted-foreground">{label}</span><Icon className="w-3 h-3 text-white/50" /></div>
    <div className="flex flex-col items-baseline"><div className="flex items-baseline gap-0.5"><span className="text-xl font-mono font-bold text-foreground tabular-nums leading-none">{value}</span>{unit && <span className="text-[10px] font-medium text-muted-foreground ml-0.5">{unit}</span>}</div>{subValue && <span className="text-[9px] text-muted-foreground font-medium mt-1">{subValue}</span>}</div>
  </div>
));
StatCard.displayName = "StatCard";

// --- MAIN COMPONENT ---
export default function GeoLocation() {
  const [mounted, setMounted] = useState(false);
  
  const { coords, error, loading } = useGeolocation();
  const { heading, trueHeading, pitch, roll, requestAccess, permissionGranted, error: compassError } = useCompass();
  useWakeLock();

  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [path, setPath] = useState<GeoPoint[]>([]);
  const [units, setUnits] = useState<UnitSystem>('metric');
  const [arMode, setArMode] = useState(false);
  const [mapMode, setMapMode] = useState<MapMode>('2d');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [stealthMode, setStealthMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedPath, setRecordedPath] = useState<GeoPoint[]>([]);
  const [isScannerMode, setIsScannerMode] = useState(false);
  const [isGestureMode, setIsGestureMode] = useState(false);
  const [target, setTarget] = useState<TargetData | null>(null);
  const [northRef, setNorthRef] = useState<NorthRef>('heading-up');
  
  useEffect(() => { setMounted(true); }, []);

  const isMoving = (coords?.speed ?? 0) > GPS_HEADING_THRESHOLD;
  const effectiveHeading = isMoving && coords?.heading ? coords.heading : heading;
  
  const targetMetrics = useMemo(() => {
      if (!coords || !target || !target.active) return null;
      const dist = getDistance(coords.latitude, coords.longitude, target.lat, target.lng);
      const bearing = getBearing(coords.latitude, coords.longitude, target.lat, target.lng);
      return { dist, bearing };
  }, [coords?.latitude, coords?.longitude, target]);

  // Audio Ops Loop
  useEffect(() => {
      if (!audioEnabled || !targetMetrics) return;
      const interval = setInterval(() => {
          const dStr = convertDistance(targetMetrics.dist, units);
          const bStr = Math.round(targetMetrics.bearing);
          speak(`Target range ${dStr}, bearing ${bStr}`);
      }, 15000); 
      return () => clearInterval(interval);
  }, [audioEnabled, targetMetrics, units]);

  useEffect(() => {
    if (!coords) return;
    const pt = { lat: coords.latitude, lng: coords.longitude, alt: coords.altitude, timestamp: Date.now() };
    setPath(p => {
        const last = p[p.length - 1];
        if (!last || getDistance(last.lat, last.lng, pt.lat, pt.lng) > TRAIL_MIN_DISTANCE) {
            return [...p, pt].slice(-TRAIL_MAX_POINTS);
        }
        return p;
    });
    if (isRecording) {
        setRecordedPath(p => {
            const last = p[p.length - 1];
            if (!last || getDistance(last.lat, last.lng, pt.lat, pt.lng) > REC_MIN_DISTANCE) return [...p, pt];
            return p;
        });
    }

    if(!weather) {
         fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=temperature_2m,weather_code,wind_speed_10m&daily=sunrise,sunset&forecast_days=1`)
        .then(r => r.json()).then(d => setWeather({ temp: d.current.temperature_2m, code: d.current.weather_code, description: getWeatherInfo(d.current.weather_code).label, windSpeed: d.current.wind_speed_10m, windDir: 0, sunrise: d.daily.sunrise, sunset: d.daily.sunset })).catch(()=>{});
    }
  }, [coords, isRecording]);

  const handleSetTarget = () => {
      triggerHaptic();
      if (!coords) return;
      if (target?.active) setTarget(null);
      else setTarget({ lat: coords.latitude, lng: coords.longitude, active: true });
  };

  const handleManualTarget = () => {
      const input = prompt("Enter Lat,Lng:");
      if(input) {
          const [lat, lng] = input.split(',').map(Number);
          if(!isNaN(lat) && !isNaN(lng)) setTarget({ lat, lng, active: true });
      }
  };

  const downloadGPX = () => {
    const blob = new Blob([generateGPX(recordedPath)], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `mission-${Date.now()}.gpx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setRecordedPath([]); setIsRecording(false);
  };

  const handleAudioToggle = () => {
      triggerHaptic();
      if(!audioEnabled) speak("Voice Ops Online");
      setAudioEnabled(!audioEnabled);
  };

  if (!mounted) return <div className="min-h-screen bg-black" />;

  return (
    <main className={`relative flex flex-col items-center min-h-[100dvh] w-full bg-[#050505] text-foreground p-4 overflow-x-hidden font-sans pb-32 ${stealthMode ? 'brightness-75 contrast-125 sepia hue-rotate-[-50deg] saturate-[3]' : ''} ${arMode ? 'overflow-hidden' : ''}`}>
      {/* Background/AR Layer */}
      {arMode ? (
          <div className="fixed inset-0 z-0">
             <Webcam className="absolute inset-0 w-full h-full object-cover" videoConstraints={{ facingMode: "environment" }} muted />
             <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40" />
             <GhostHUD heading={effectiveHeading} pitch={pitch} roll={roll} targetBearing={targetMetrics?.bearing ?? null} targetDist={targetMetrics ? convertDistance(targetMetrics.dist, units) : null} />
          </div>
      ) : (
          <div className="absolute inset-0 pointer-events-none z-0 bg-[radial-gradient(circle_at_top,rgba(34,197,94,0.05),transparent_60%)]" />
      )}

      {/* Header */}
      <div className={`w-full max-w-5xl flex justify-between items-center z-40 mb-6 shrink-0 backdrop-blur-sm p-2 rounded-xl border border-white/5 transition-all ${arMode ? "bg-black/40" : ""}`}>
         <div className="flex flex-col">
             <div className="flex items-center gap-2"><Scan className="w-4 h-4 text-green-500" /><h1 className="text-sm font-black tracking-[0.2em] text-white/80 uppercase">Field<span className="text-white/30">Nav</span> <span className="text-xs text-green-500 ml-2">MK-III</span></h1></div>
             <div className="flex items-center gap-1.5 mt-1 ml-0.5"><div className={`w-1.5 h-1.5 rounded-full ${coords ? "bg-green-500 shadow-[0_0_5px_#22c55e]" : "bg-red-500"}`} /><span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{coords ? "ONLINE" : "SEARCHING"}</span></div>
         </div>
         <div className="flex gap-2 items-center">
            <button onClick={handleAudioToggle} className={`p-2 rounded-full border text-[10px] transition-all ${audioEnabled ? "bg-green-500/10 text-green-500 border-green-500/50" : "bg-white/5 border-white/10 text-muted-foreground"}`}><Headphones className="w-4 h-4" /></button>
            <button onClick={() => setStealthMode(!stealthMode)} className={`p-2 rounded-full border text-[10px] transition-all ${stealthMode ? "bg-red-900/20 text-red-500 border-red-500/50" : "bg-white/5 border-white/10 text-muted-foreground"}`}><EyeOff className="w-4 h-4" /></button>
            <button onClick={() => { setArMode(!arMode); triggerHaptic(); }} className={`flex items-center gap-2 px-3 py-2 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all ${arMode ? "bg-green-500 text-black border-green-500" : "bg-white/5 border-white/10 text-muted-foreground"}`}><Aperture className="w-3 h-3" /> {arMode ? "HUD" : "2D"}</button>
            <button onClick={() => setIsRecording(!isRecording)} className={`flex items-center gap-2 px-3 py-2 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all ${isRecording ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-white/5 border-white/10 text-muted-foreground"}`}>{isRecording ? "REC" : "LOG"}</button>
         </div>
      </div>

      {isScannerMode && (
        <div className="fixed inset-0 z-50 animate-in fade-in zoom-in duration-300">
            <TacticalScanner />
            <button onClick={() => setIsScannerMode(false)} className="absolute top-4 right-4 z-[60] p-3 bg-black/50 border border-white/20 rounded-full text-white backdrop-blur-md"><X className="w-6 h-6" /></button>
        </div>
      )}

      {isGestureMode && <GestureOps onToggleRecording={() => setIsRecording(!isRecording)} onToggleMapMode={() => setMapMode(m => m==='2d'?'3d':'2d')} isRecording={isRecording} />}

      {/* Main Dashboard */}
      <div className={`w-full max-w-5xl flex flex-col items-center z-10 space-y-6 transition-opacity duration-300 ${arMode ? 'opacity-80 hover:opacity-100' : 'opacity-100'}`}>
        {loading && !coords && <div className="flex flex-col items-center justify-center h-64 space-y-4 animate-pulse"><Loader2 className="w-8 h-8 animate-spin text-green-500/50" /><span className="text-xs tracking-[0.3em] uppercase text-green-500/70 font-bold">Acquiring Satellites...</span></div>}
        
        {coords && (
          <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-6">
             {/* Left Panel: Data & Controls */}
             <div className={`lg:col-span-4 flex flex-col gap-4 order-2 lg:order-1 ${arMode ? "hidden md:flex" : ""}`}>
                 <div className="p-4 rounded-xl bg-[#111]/80 border border-white/10 backdrop-blur-md space-y-4 shadow-xl">
                    <div className="flex items-center justify-between"><span className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest flex items-center gap-2"><MapPin className="w-3 h-3 text-green-500" /> Position</span><div className="flex items-center gap-1 px-2 py-1 bg-black/40 rounded border border-white/10"><Signal className="w-3 h-3 text-green-500" /><span className="text-[9px] font-mono font-bold text-white/70">GPS</span></div></div>
                    <div className="space-y-2">
                       <div className="flex justify-between p-2.5 rounded-lg bg-black/40 border border-white/5"><span className="text-[8px] uppercase tracking-widest font-bold text-muted-foreground">LAT</span><span className="text-lg font-mono font-medium text-foreground">{formatCoordinate(coords.latitude, 'lat')}</span></div>
                       <div className="flex justify-between p-2.5 rounded-lg bg-black/40 border border-white/5"><span className="text-[8px] uppercase tracking-widest font-bold text-muted-foreground">LNG</span><span className="text-lg font-mono font-medium text-foreground">{formatCoordinate(coords.longitude, 'lng')}</span></div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/5">
                        <button onClick={handleSetTarget} className={`py-3 rounded-lg border text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${target?.active ? "bg-red-500/10 border-red-500/30 text-red-500" : "bg-blue-500/10 border-blue-500/20 text-blue-400"}`}>
                            {target?.active ? <Trash2 className="w-3.5 h-3.5" /> : <Target className="w-3.5 h-3.5" />} {target?.active ? "Clear" : "Mark"}
                        </button>
                        <button onClick={handleManualTarget} className="py-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 text-[10px] font-bold uppercase tracking-widest">Input</button>
                    </div>
                 </div>

                 {target?.active && targetMetrics ? (
                     <div className="p-4 rounded-xl bg-blue-950/40 border border-blue-500/30 backdrop-blur-md flex items-center justify-between shadow-[0_0_15px_rgba(59,130,246,0.2)]">
                         <div className="flex flex-col"><span className="text-[9px] uppercase font-bold text-blue-400 tracking-widest mb-1">Bearing</span><span className="text-2xl font-mono font-bold text-white tabular-nums">{Math.round(targetMetrics.bearing)}°</span></div>
                         <div className="h-8 w-px bg-blue-500/20" />
                         <div className="flex flex-col items-end"><span className="text-[9px] uppercase font-bold text-blue-400 tracking-widest mb-1">Range</span><span className="text-2xl font-mono font-bold text-white tabular-nums">{convertDistance(targetMetrics.dist, units)}</span></div>
                     </div>
                 ) : (
                    weather && (
                        <div className="p-4 rounded-xl bg-[#111]/60 border border-white/5 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <Sun className="w-8 h-8 text-amber-500/80" />
                                <div><div className="text-2xl font-mono font-bold">{convertTemp(weather.temp, units)}</div><div className="text-[10px] text-muted-foreground uppercase">{weather.description}</div></div>
                            </div>
                        </div>
                    )
                 )}

                 <div className="grid grid-cols-3 gap-3">
                    <StatCard icon={Mountain} label="ALT" value={convertAltitude(coords.altitude, units)} unit={units === 'metric'?'m':'ft'} />
                    <StatCard icon={Activity} label="SPD" value={convertSpeed(coords.speed, units)} unit={units === 'metric'?'kph':'mph'} />
                    <StatCard icon={Navigation} label="ACC" value={coords.accuracy ? `±${Math.round(coords.accuracy)}` : '--'} unit="m" />
                 </div>
                 
                 <div className="flex gap-2">
                     <button onClick={() => setIsScannerMode(true)} className="flex-1 py-3 bg-white/5 border border-white/10 rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2 hover:bg-white/10"><Scan className="w-4 h-4"/> Optics</button>
                     <button onClick={() => setIsGestureMode(!isGestureMode)} className={`flex-1 py-3 border rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2 ${isGestureMode ? "bg-green-500/20 text-green-500 border-green-500/50" : "bg-white/5 border-white/10"}`}><Hand className="w-4 h-4"/> Gestures</button>
                 </div>
             </div>

             {/* Right Panel: Visuals */}
             <div className="lg:col-span-8 flex flex-col gap-6 order-1 lg:order-2 h-[50vh] lg:h-auto">
                 {/* Map System */}
                 <div className="relative w-full h-[400px] lg:h-[500px] rounded-2xl border border-white/10 overflow-hidden shadow-2xl bg-[#0c0c0c] group">
                     {mapMode === '3d' ? (
                        <Mapbox3D path={path} lat={coords.latitude} lng={coords.longitude} heading={effectiveHeading} target={target} />
                     ) : (
                         <RadarMapbox 
                            path={path} lat={coords.latitude} lng={coords.longitude} heading={effectiveHeading} 
                            mode={northRef} accuracy={coords.accuracy} 
                            onRecenter={() => setPath([{ lat: coords.latitude, lng: coords.longitude, alt: coords.altitude, timestamp: Date.now() }])}
                            onToggleMode={() => setNorthRef(n => n === 'heading-up' ? 'north-up' : 'heading-up')}
                         />
                     )}
                     
                     <div className="absolute bottom-4 left-4 flex gap-2">
                         <button onClick={() => setMapMode(m => m==='2d'?'3d':'2d')} className="p-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white hover:bg-white/10 transition-all">
                            {mapMode==='2d' ? <Box className="w-5 h-5 text-blue-400" /> : <Globe className="w-5 h-5 text-green-400" />}
                         </button>
                     </div>
                 </div>
                 
                 {/* Compass & Inclinometer */}
                 {!arMode && (
                     <div className="flex flex-col md:flex-row items-center justify-center gap-8 py-4">
                         <CompassDisplay 
                            heading={effectiveHeading} 
                            trueHeading={isMoving ? coords.heading : trueHeading} 
                            onClick={requestAccess} 
                            hasError={!!compassError} 
                            permissionGranted={permissionGranted}
                            source={isMoving ? 'GPS' : 'MAG'}
                            targetBearing={targetMetrics?.bearing ?? null}
                         />
                         <Inclinometer pitch={pitch} roll={roll} />
                     </div>
                 )}
             </div>
          </div>
        )}
        
        {recordedPath.length > 0 && !isRecording && (
          <button onClick={downloadGPX} className="fixed bottom-8 left-1/2 -translate-x-1/2 px-8 py-4 rounded-full bg-green-500 text-black font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(34,197,94,0.4)] flex items-center gap-2 animate-in slide-in-from-bottom-4 z-[60]"><Download className="w-5 h-5" /> Download Log</button>
        )}
      </div>
    </main>
  );
}