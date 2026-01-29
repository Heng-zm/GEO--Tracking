"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, Loader2,
  Trash2, Crosshair, Compass as CompassIcon, WifiOff,
  Maximize2, X, LocateFixed, Circle, Download, Sunrise, Sunset, Moon, Wind,
  Share2, Signal, Plus, Minus, Copy, Check, RotateCw, Layers, Scan,
  ArrowUp, Hand, Video, VideoOff, Eye, Zap
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- TensorFlow & Webcam ---
import Webcam from "react-webcam";
import * as tf from "@tensorflow/tfjs";
import * as handpose from "@tensorflow-models/handpose";
import '@tensorflow/tfjs-backend-webgl';

// --- Mapbox GL JS ---
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// --- Configuration ---
const MAPBOX_TOKEN = "pk.eyJ1Ijoib3BlbnN0cmVldGNhbSIsImEiOiJja252Ymh4ZnIwNHdkMnd0ZzF5NDVmdnR5In0.dYxz3TzZPTPzd_ibMeGK2g";
mapboxgl.accessToken = MAPBOX_TOKEN;

const RADAR_ZOOM = 18;
const TRAIL_MAX_POINTS = 100; 
const TRAIL_MIN_DISTANCE = 5; 
const MAP_UPDATE_THRESHOLD = 80; 
const API_FETCH_DISTANCE_THRESHOLD = 2.0; 
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
type MapMode = 'heading-up' | 'north-up';
type MapStyle = 'satellite' | 'dark';

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const triggerHaptic = () => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(20);
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

const formatTime = (isoString: string) => {
  if (!isoString) return "--:--";
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return "--:--";
  }
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

const getCompassDirection = (degree: number) => {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((degree % 360) + 360) % 360;
  return directions[Math.round(normalized / 45) % 8];
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

const calculateTotalDistance = (points: GeoPoint[]) => {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += getDistance(points[i].lat, points[i].lng, points[i+1].lat, points[i+1].lng);
  }
  return total;
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

// --- Hooks ---
const useWakeLock = () => {
  const wakeLockRef = useRef<any>(null);

  const requestLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      }
    } catch (err) {}
  }, []);

  const releaseLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err) {}
    }
  }, []);

  useEffect(() => {
    requestLock();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestLock();
      else releaseLock();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      releaseLock();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [requestLock, releaseLock]);
};

const useGeolocation = () => {
  const [state, setState] = useState<GeoState>({ coords: null, error: null, loading: true });
  const lastUpdate = useRef<number>(0);
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setState({ coords: null, loading: false, error: "Geolocation not supported" });
      return;
    }

    const startWatching = () => {
      watchId.current = navigator.geolocation.watchPosition(
        ({ coords }: GeolocationPosition) => {
          const now = Date.now();
          if (now - lastUpdate.current < 500) return; // Throttle 500ms
          if (isNaN(coords.latitude) || isNaN(coords.longitude)) return;
          lastUpdate.current = now;

          setState(prev => {
            if (prev.coords && 
                prev.coords.latitude === coords.latitude && 
                prev.coords.longitude === coords.longitude &&
                Math.abs((prev.coords.heading || 0) - (coords.heading || 0)) < 1) {
              return prev;
            }
            return {
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
            };
          });
        }, 
        (error) => {
          if (error.code === error.TIMEOUT) return; 
          setState(s => ({ ...s, loading: false, error: "Signal Lost" }));
        }, 
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }
      );
    };

    startWatching();
    return () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current); };
  }, []);

  return state;
};

const useCompass = () => {
  const [visualHeading, setVisualHeading] = useState<number | null>(null);
  const [trueHeading, setTrueHeading] = useState<number | null>(null);
  const [pitch, setPitch] = useState<number>(0);
  const [roll, setRoll] = useState<number>(0);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const targetHeadingRef = useRef<number>(0);
  const currentHeadingRef = useRef<number>(0);
  const targetPitchRef = useRef<number>(0);
  const currentPitchRef = useRef<number>(0);
  const targetRollRef = useRef<number>(0);
  const currentRollRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    isRunningRef.current = true;
    return () => { isRunningRef.current = false; };
  }, []);
  
  useEffect(() => {
    if (!permissionGranted) return;
    
    const loop = () => {
      if (!isRunningRef.current) return;
      
      const hDiff = targetHeadingRef.current - currentHeadingRef.current;
      if (Math.abs(hDiff) > 0.1) {
          currentHeadingRef.current += hDiff * 0.15;
          setVisualHeading((currentHeadingRef.current % 360 + 360) % 360);
      } else if (currentHeadingRef.current !== targetHeadingRef.current) {
          currentHeadingRef.current = targetHeadingRef.current;
          setVisualHeading((currentHeadingRef.current % 360 + 360) % 360);
      }

      const pDiff = targetPitchRef.current - currentPitchRef.current;
      if (Math.abs(pDiff) > 0.1) {
          currentPitchRef.current += pDiff * 0.1;
          setPitch(currentPitchRef.current);
      }

      const rDiff = targetRollRef.current - currentRollRef.current;
      if (Math.abs(rDiff) > 0.1) {
          currentRollRef.current += rDiff * 0.1;
          setRoll(currentRollRef.current);
      }
      rafIdRef.current = requestAnimationFrame(loop);
    };
    rafIdRef.current = requestAnimationFrame(loop);
    return () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
  }, [permissionGranted]);

  const requestAccess = useCallback(async () => {
    triggerHaptic();
    if (typeof DeviceOrientationEvent === 'undefined') {
      setError("Sensor not found");
      return;
    }
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') { setPermissionGranted(true); setError(null); } else { setError("Denied"); }
      } catch (e) { setError("Not supported"); }
    } else { 
      setPermissionGranted(true); 
    }
  }, []);

  useEffect(() => {
    if (!permissionGranted || typeof window === 'undefined') return;
    const handleOrientation = (e: any) => {
      let degree: number | null = null;
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) degree = e.webkitCompassHeading;
      else if (e.alpha !== null) degree = Math.abs(360 - e.alpha);

      if (degree !== null) {
        const normalized = ((degree) + 360) % 360;
        setTrueHeading(normalized);
        const current = targetHeadingRef.current;
        const currentMod = (current % 360 + 360) % 360;
        let delta = normalized - currentMod;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        targetHeadingRef.current = current + delta;
      }
      if (e.beta !== null) targetPitchRef.current = e.beta;
      if (e.gamma !== null) targetRollRef.current = e.gamma;
    };
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handleOrientation, true);
    return () => window.removeEventListener(eventName, handleOrientation, true);
  }, [permissionGranted]);

  return { heading: visualHeading, trueHeading, pitch, roll, requestAccess, permissionGranted, error };
};

const useDebounce = <T,>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
};

// --- OPTIMIZED GESTURE COMPONENT ---
const GestureOps = memo(({ 
  onToggleRecording, 
  onToggleMapMode,
  isRecording 
}: { 
  onToggleRecording: () => void, 
  onToggleMapMode: () => void,
  isRecording: boolean
}) => {
  const webcamRef = useRef<Webcam>(null);
  const [model, setModel] = useState<handpose.HandPose | null>(null);
  const [loading, setLoading] = useState(true);
  const [gestureState, setGestureState] = useState<'neutral' | 'pinch' | 'fist'>('neutral');
  const [debugMsg, setDebugMsg] = useState("Initializing AI...");
  const isMountedRef = useRef(true);

  // Performance Optimization: Run TF.js configuration once
  useEffect(() => {
    isMountedRef.current = true;
    const initTF = async () => {
      try {
        await tf.ready();
        // Force WebGL backend
        await tf.setBackend('webgl');
        // Optimize WebGL flags for mobile garbage collection
        tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0);
        
        const net = await handpose.load();
        if (isMountedRef.current) {
          setModel(net);
          setLoading(false);
          setDebugMsg("AI Ready");
        }
      } catch (e) {
        console.error("AI Load Failed", e);
        if (isMountedRef.current) setDebugMsg("AI Error");
      }
    };
    initTF();
    return () => { isMountedRef.current = false; };
  }, []);

  // Performance Optimization: Detection Loop
  useEffect(() => {
    if (!model) return;

    let rafId: number;
    let timeoutId: NodeJS.Timeout;
    let lastActionTime = 0;
    
    // Confidence counters to prevent accidental triggers
    let consecutivePinchFrames = 0;
    let consecutiveFistFrames = 0;
    const FRAMES_TO_TRIGGER = 3; 
    const ACTION_COOLDOWN = 1200; 
    
    // THROTTLE: Only run detection every ~150ms (approx 6-7 FPS) to save battery
    const DETECTION_INTERVAL = 150; 

    const loop = async () => {
      if (!isMountedRef.current) return;

      if (
        webcamRef.current &&
        webcamRef.current.video &&
        webcamRef.current.video.readyState === 4
      ) {
        const video = webcamRef.current.video;
        
        // Use tf.tidy to automatically clean up intermediate tensors
        const hands = await model.estimateHands(video);

        if (isMountedRef.current) {
          if (hands.length > 0) {
            const landmarks = hands[0].landmarks;

            // 1. PINCH (Thumb tip to Index tip)
            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            const pinchDist = Math.sqrt(
              Math.pow(thumbTip[0] - indexTip[0], 2) +
              Math.pow(thumbTip[1] - indexTip[1], 2)
            );

            // 2. FIST (Thumb tip to Pinky tip)
            const pinkyTip = landmarks[20];
            const fistDist = Math.sqrt(
              Math.pow(thumbTip[0] - pinkyTip[0], 2) +
              Math.pow(thumbTip[1] - pinkyTip[1], 2)
            );

            const now = Date.now();

            // Check distances (thresholds calibrated for 160px width)
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
      }
      
      // Throttle the loop
      timeoutId = setTimeout(() => {
        rafId = requestAnimationFrame(loop);
      }, DETECTION_INTERVAL);
    };

    loop();

    return () => { 
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [model, onToggleRecording, onToggleMapMode, isRecording]);

  return (
    <div className="absolute top-20 right-4 w-28 h-36 bg-black/90 rounded-xl border border-green-500/30 overflow-hidden z-50 shadow-2xl backdrop-blur-md transition-all animate-in fade-in zoom-in duration-300">
       <Webcam
          ref={webcamRef}
          className="absolute inset-0 w-full h-full object-cover opacity-50 grayscale"
          mirrored={true}
          // OPTIMIZATION: Ultra-low resolution for faster processing
          videoConstraints={{ width: 160, height: 120, facingMode: "user" }}
          screenshotFormat="image/jpeg"
       />
       
       <div className="absolute inset-0 flex flex-col items-center justify-between p-2 pointer-events-none">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-green-500" />
                <span className="text-[8px] font-mono text-green-500/80 animate-pulse">BOOTING AI</span>
            </div>
          ) : (
             <div className="mt-8 transition-all duration-200">
               {gestureState === 'neutral' && <Hand className="w-8 h-8 text-white/40" />}
               {gestureState === 'pinch' && <Scan className="w-8 h-8 text-green-400 animate-pulse drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]" />}
               {gestureState === 'fist' && <Circle className="w-8 h-8 text-red-500 fill-red-500/50 animate-pulse drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]" />}
             </div>
          )}
          
          {!loading && (
            <div className="w-full bg-black/80 backdrop-blur-md rounded text-[8px] font-mono text-center py-1 text-green-400 border-t border-green-500/20">
                {debugMsg}
            </div>
          )}
       </div>

       {/* Corner Accents */}
       <div className="absolute top-0 left-0 w-2 h-2 border-l border-t border-green-500/50" />
       <div className="absolute top-0 right-0 w-2 h-2 border-r border-t border-green-500/50" />
       <div className="absolute bottom-0 left-0 w-2 h-2 border-l border-b border-green-500/50" />
       <div className="absolute bottom-0 right-0 w-2 h-2 border-r border-b border-green-500/50" />
       
       {/* Active Indicator */}
       <div className="absolute top-1 right-1">
           <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shadow-[0_0_5px_#22c55e]" />
       </div>
    </div>
  );
});
GestureOps.displayName = "GestureOps";

// --- UI Components ---
const Inclinometer = memo(({ pitch, roll }: { pitch: number | null, roll: number | null }) => {
  const p = pitch || 0;
  const r = roll || 0;
  const visualP = Math.max(Math.min(p, 60), -60);
  const pxPerDeg = 2; 

  return (
    <div className="relative w-40 h-40 shrink-0 rounded-full border-[6px] border-[#1a1a1a] bg-[#0c0c0c] overflow-hidden shadow-2xl ring-1 ring-white/10 group select-none">
       <div className="absolute inset-0 rounded-full border-2 border-white/5 pointer-events-none z-30" />
       <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-1.5 bg-yellow-500 z-40" />
       <div className="absolute top-0.5 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-b-[6px] border-b-yellow-500 z-40" />
      <div className="absolute inset-[-50%] will-change-transform origin-center" style={{ transform: `rotate(${-r}deg) translateY(${visualP * pxPerDeg}px)`, transition: 'transform 0.1s linear' }}>
        <div className="w-full h-1/2 bg-[#0066cc]/30 border-b-2 border-white/80 shadow-[0_0_10px_rgba(255,255,255,0.2)]" /> 
        <div className="w-full h-1/2 bg-[#663300]/40 border-t-2 border-white/80 shadow-[0_0_10px_rgba(255,255,255,0.2)]" /> 
        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-white/50" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full pointer-events-none">
            {PITCH_LADDER_LINES.map(deg => (
                <div key={deg} className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center gap-2 w-full opacity-60" style={{ top: `calc(50% - ${deg * pxPerDeg}px)` }}>
                    <span className="text-[6px] font-mono font-bold text-white/90 w-3 text-right drop-shadow-md">{Math.abs(deg)}</span>
                    <div className="h-px bg-white/80 w-6 shadow-[0_0_2px_black]" />
                    <span className="text-[6px] font-mono font-bold text-white/90 w-3 text-left drop-shadow-md">{Math.abs(deg)}</span>
                </div>
            ))}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
        <div className="w-1.5 h-1.5 bg-yellow-400 rounded-full shadow-[0_0_4px_rgba(250,204,21,1)] z-10 border border-black/20" />
        <div className="absolute flex gap-8">
             <div className="w-8 h-1 bg-yellow-400/80 rounded-full shadow-sm" />
             <div className="w-8 h-1 bg-yellow-400/80 rounded-full shadow-sm" />
        </div>
      </div>
      <div className="absolute top-2 inset-x-0 flex justify-center z-20 pointer-events-none">
           <div className="w-24 h-24 rounded-full border-t border-white/30 absolute top-0 mask-image-gradient" />
           {BANKING_SCALE_TICKS.map(deg => (
               <div key={deg} className="absolute top-0 h-2 w-px bg-white/40 origin-bottom" style={{ transform: `rotate(${deg}deg) translateY(2px)`, transformOrigin: 'center 68px' }} />
           ))}
      </div>
      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-white/10 via-transparent to-black/40 pointer-events-none z-50" />
      <div className="absolute bottom-3 inset-x-0 flex justify-between px-8 text-[7px] font-mono font-bold text-white/50 pointer-events-none z-40">
        <div className="flex flex-col items-center bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
            <span className="text-[5px] uppercase tracking-wider text-white/40">Roll</span>
            <span className="text-white tabular-nums">{r.toFixed(0)}°</span>
        </div>
        <div className="flex flex-col items-center bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
            <span className="text-[5px] uppercase tracking-wider text-white/40">Pitch</span>
            <span className="text-white tabular-nums">{p.toFixed(0)}°</span>
        </div>
      </div>
    </div>
  );
});
Inclinometer.displayName = "Inclinometer";

const RadarMapbox = memo(({ 
  path, 
  heading, 
  lat, 
  lng,
  mode,
  accuracy,
  zoom,
  onRecenter,
  onToggleMode
}: { 
  path: GeoPoint[], 
  heading: number, 
  lat: number, 
  lng: number,
  mode: MapMode,
  accuracy: number | null,
  zoom: number,
  onRecenter: () => void,
  onToggleMode: () => void
}) => {
  const [anchor, setAnchor] = useState({ lat, lng });
  const [isOffCenter, setIsOffCenter] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyle>('satellite');

  useEffect(() => {
    const distance = getDistance(anchor.lat, anchor.lng, lat, lng);
    setIsOffCenter(distance > 30); 
    if (distance > MAP_UPDATE_THRESHOLD) {
      setAnchor({ lat, lng });
      setImgLoaded(false); 
      setMapError(false);
    }
  }, [lat, lng, anchor]);

  const styleId = mapStyle === 'satellite' ? 'satellite-streets-v12' : 'dark-v11';
  const currentMapUrl = useMemo(() => 
    `https://api.mapbox.com/styles/v1/mapbox/${styleId}/static/${anchor.lng},${anchor.lat},${zoom},0,0/600x600@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, 
  [anchor.lat, anchor.lng, styleId, zoom]);

  const { userX, userY, svgPath } = useMemo(() => {
    const userPos = geoToPixels(lat, lng, anchor.lat, anchor.lng, zoom);
    let pathD = "";
    if (path.length > 1) {
      const points = path.map(p => {
        const pt = geoToPixels(p.lat, p.lng, anchor.lat, anchor.lng, zoom);
        return `${pt.x},${pt.y}`;
      });
      pathD = "M " + points.join(" L ");
    }
    return { userX: userPos.x, userY: userPos.y, svgPath: pathD };
  }, [lat, lng, anchor, path, zoom]);

  const rotation = mode === 'heading-up' ? heading : 0;
  const markerRotation = mode === 'heading-up' ? 0 : heading;
  
  const accColor = !accuracy ? 'border-muted/20' 
    : accuracy < 10 ? 'border-green-500/50' 
    : accuracy < 30 ? 'border-yellow-500/50' 
    : 'border-red-500/50';

  const toggleStyle = useCallback(() => {
      triggerHaptic();
      setMapStyle(prev => prev === 'satellite' ? 'dark' : 'satellite');
      setImgLoaded(false);
  }, []);

  return (
    <div className="relative w-64 h-64 md:w-72 md:h-72 shrink-0 select-none group flex flex-col items-center">
      <div className="w-full h-full relative isolate rounded-full overflow-hidden border border-white/10 bg-black/80 shadow-2xl z-10">
        <div className="absolute inset-0 rounded-full bg-black z-0" style={{ maskImage: 'radial-gradient(white, black)', transform: 'translateZ(0)' }}>
          <div className="w-full h-full absolute inset-0 will-change-transform transition-transform duration-100 ease-linear origin-center" style={{ transform: `rotate(${-rotation}deg) scale(1.02)` }}>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[220%] h-[220%]">
               <div className="absolute inset-0 bg-[#0a0f0a]" />
               {!mapError && (
                 <img src={currentMapUrl} alt="Map View" onLoad={() => setImgLoaded(true)} onError={() => setMapError(true)} className={`w-full h-full object-contain transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`} style={{ filter: mapStyle === 'satellite' ? 'grayscale(0.3) contrast(1.1) brightness(0.9)' : 'contrast(1.2) brightness(0.8)' }} />
               )}
            </div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] pointer-events-none z-10">
              <svg viewBox="-200 -200 400 400" className="w-full h-full overflow-visible">
                {svgPath && <path d={svgPath} fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" />}
                <g transform={`translate(${userX}, ${userY})`}>
                   <g transform={`rotate(${markerRotation})`}>
                      <path d="M -6 -6 L 0 -18 L 6 -6" fill="rgba(34,197,94,0.9)" />
                      <circle r="4" fill="#22c55e" className="animate-pulse" />
                      <circle r="7" fill="none" stroke="#ffffff" strokeWidth="1.5" className="opacity-90" />
                   </g>
                </g>
              </svg>
            </div>
          </div>
        </div>
        <div className="absolute inset-0 rounded-full border border-white/5 pointer-events-none z-20">
            <div className="absolute inset-[25%] rounded-full border border-white/5" />
            <div className="absolute inset-[50%] rounded-full border border-white/5" />
        </div>
        <div className={`absolute inset-0 rounded-full border-[3px] ${accColor} pointer-events-none z-10 opacity-40`} />
        <div className="absolute inset-0 rounded-full pointer-events-none overflow-hidden z-20">
             <div className="absolute inset-[-50%] bg-[conic-gradient(from_0deg,transparent_0deg,transparent_300deg,rgba(34,197,94,0.08)_360deg)] animate-[spin_4s_linear_infinite]" />
        </div>
        <div className="absolute inset-0 pointer-events-none z-30 opacity-30">
           <div className="absolute top-1/2 left-0 w-full h-px bg-white/30" />
           <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
           <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-white/20 rounded-full" />
        </div>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none z-30" style={{ transform: `rotate(${-rotation}deg)`, transformOrigin: 'center 110px' }}>
            <div className="text-[8px] font-black text-white bg-red-600 px-1 rounded-sm shadow-md">N</div>
        </div>
      </div>
      <div className="absolute -bottom-5 z-40 flex items-center gap-1 bg-[#111] p-1 rounded-full border border-white/10 shadow-xl backdrop-blur-md">
            <button onClick={() => { triggerHaptic(); onToggleMode(); }} type="button" className={`text-[9px] font-bold px-3 py-1.5 rounded-full border transition-all ${mode === 'heading-up' ? 'bg-green-500/20 text-green-500 border-green-500/20' : 'bg-transparent text-muted-foreground border-transparent hover:text-white'}`}>
              {mode === 'heading-up' ? 'HDG' : 'NTH'}
            </button>
            <div className="w-px h-3 bg-white/10" />
            <button onClick={toggleStyle} type="button" className="p-1.5 rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-colors">
              <Layers className="w-3.5 h-3.5" />
            </button>
             {isOffCenter && (
                 <>
                    <div className="w-px h-3 bg-white/10" />
                    <button onClick={() => { triggerHaptic(); onRecenter(); }} type="button" className="p-1.5 rounded-full text-blue-400 hover:bg-blue-500/10 transition-colors">
                    <Crosshair className="w-3.5 h-3.5" />
                    </button>
                </>
            )}
      </div>
    </div>
  );
});
RadarMapbox.displayName = "RadarMapbox";

const CompassTicks = memo(() => (
  <>
    <circle cx="50" cy="50" r="46" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/20 fill-none" />
    {COMPASS_TICKS.map((_, i) => {
      const isCardinal = i % 18 === 0;
      const isMajor = i % 6 === 0;
      const length = isCardinal ? 6 : isMajor ? 3 : 1.5;
      const width = isCardinal ? 1 : isMajor ? 0.5 : 0.25;
      const colorClass = isCardinal ? "text-white" : isMajor ? "text-white/60" : "text-white/20";
      return (
        <line key={i} x1="50" y1="5" x2="50" y2={5 + length} transform={`rotate(${i * 5} 50 50)`} stroke="currentColor" strokeWidth={width} className={colorClass} strokeLinecap="square" />
      );
    })}
  </>
));
CompassTicks.displayName = "CompassTicks";

const CompassDisplay = memo(({ 
  heading, 
  trueHeading, 
  onClick, 
  hasError, 
  permissionGranted,
  source
}: { 
  heading: number | null, 
  trueHeading: number | null, 
  onClick: () => void, 
  hasError: boolean, 
  permissionGranted: boolean,
  source: 'GPS' | 'MAG'
}) => {
  const rotation = heading || 0;
  const directionStr = trueHeading !== null ? getCompassDirection(trueHeading) : "--";
  const displayHeading = trueHeading !== null ? Math.round(trueHeading) : 0;

  return (
    <div className="flex flex-col items-center justify-center relative z-10 shrink-0">
      <div 
        className="relative w-64 h-64 md:w-72 md:h-72 cursor-pointer group select-none touch-manipulation transition-all duration-300" 
        onClick={onClick}
        role="button"
        aria-label="Calibrate Compass"
      >
        <div className="absolute inset-0 rounded-full border-[10px] border-[#0c0c0c] bg-[#111] shadow-2xl flex items-center justify-center ring-1 ring-white/10">
             <div className="absolute top-1 text-[10px] font-black text-red-500">N</div>
             <div className="absolute right-2 text-[10px] font-black text-white/30">E</div>
             <div className="absolute bottom-2 text-[10px] font-black text-white/30">S</div>
             <div className="absolute left-2 text-[10px] font-black text-white/30">W</div>
             <div className="absolute top-0 -translate-y-1 w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-t-[10px] border-t-red-600 drop-shadow-[0_4px_4px_rgba(0,0,0,0.5)] z-20" />
        </div>
        <div className="absolute inset-4 will-change-transform transition-transform duration-100 ease-linear rounded-full bg-[radial-gradient(circle,rgba(30,30,30,1)_0%,rgba(10,10,10,1)_100%)] border border-white/5" style={{ transform: `rotate(${-rotation}deg)` }}>
          <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none p-1">
            <CompassTicks />
          </svg>
        </div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center z-20 pointer-events-none">
             <span className="text-5xl font-mono font-black tracking-tighter text-white tabular-nums drop-shadow-lg">
                {permissionGranted || source === 'GPS' ? `${displayHeading}°` : "--"}
             </span>
             <div className="flex items-center gap-1 mt-1">
                 <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${source === 'GPS' ? 'text-green-500 border-green-500/20 bg-green-500/5' : 'text-blue-500 border-blue-500/20 bg-blue-500/5'}`}>
                 {source}
                 </span>
                 <span className="text-[9px] font-bold text-white/50 tracking-widest uppercase bg-white/5 px-2 py-0.5 rounded-full border border-white/10">
                    {permissionGranted || source === 'GPS' ? directionStr : "---"}
                 </span>
             </div>
        </div>
        {!permissionGranted && !hasError && source === 'MAG' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full z-30 bg-black/60 backdrop-blur-sm">
            <button type="button" className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white animate-pulse bg-blue-600/20 px-4 py-2 rounded-full border border-blue-500/50 shadow-xl hover:bg-blue-600/30 transition-colors">
              <CompassIcon className="w-3 h-3" /> Align
            </button>
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center z-30 bg-background/50 backdrop-blur-sm rounded-full">
            <WifiOff className="w-8 h-8 text-destructive/80" />
          </div>
        )}
      </div>
    </div>
  );
});
CompassDisplay.displayName = "CompassDisplay";

const DataCard = memo(({ children, className }: { children: React.ReactNode, className?: string }) => (
    <div className={`relative p-4 rounded-xl bg-[#111]/60 border border-white/5 backdrop-blur-md overflow-hidden ${className}`}>
        <div className="absolute top-0 left-0 w-2 h-2 border-l border-t border-white/20" />
        <div className="absolute top-0 right-0 w-2 h-2 border-r border-t border-white/20" />
        <div className="absolute bottom-0 left-0 w-2 h-2 border-l border-b border-white/20" />
        <div className="absolute bottom-0 right-0 w-2 h-2 border-r border-b border-white/20" />
        {children}
    </div>
));
DataCard.displayName = "DataCard";

const StatCard = memo(({ icon: Icon, label, value, subValue, unit }: { icon: any, label: string, value: string, subValue?: string, unit?: string }) => (
  <DataCard className="flex flex-col items-start justify-between min-w-[90px] h-full shadow-lg group hover:border-white/10 transition-colors">
    <div className="flex w-full items-center justify-between mb-2 opacity-60">
      <span className="text-[9px] uppercase tracking-widest font-bold text-muted-foreground group-hover:text-white transition-colors">{label}</span>
      <Icon className="w-3 h-3 text-white/50" />
    </div>
    <div className="flex flex-col items-baseline">
      <div className="flex items-baseline gap-0.5">
         <span className="text-xl font-mono font-bold text-foreground tracking-tight tabular-nums leading-none">{value}</span>
         {unit && <span className="text-[10px] font-medium text-muted-foreground ml-0.5">{unit}</span>}
      </div>
      {subValue && <span className="text-[9px] text-muted-foreground font-medium mt-1">{subValue}</span>}
    </div>
  </DataCard>
));
StatCard.displayName = "StatCard";

const SolarCard = memo(({ sunrise, sunset }: { sunrise: string[], sunset: string[] }) => {
  const now = new Date().getTime();
  const riseToday = new Date(sunrise[0]).getTime();
  const setToday = new Date(sunset[0]).getTime();
  const riseTomorrow = new Date(sunrise[1]).getTime();

  let isDay = false;
  let nextEventLabel = "Sunrise";
  let nextEventTime = riseToday;
  let progress = 0;

  if (now < riseToday) {
    isDay = false;
    nextEventLabel = "Sunrise";
    nextEventTime = riseToday;
    const prevSunset = setToday - (24 * 3600 * 1000); 
    const nightLength = riseToday - prevSunset;
    progress = 100 - ((riseToday - now) / nightLength) * 100;
  } else if (now >= riseToday && now < setToday) {
    isDay = true;
    nextEventLabel = "Sunset";
    nextEventTime = setToday;
    const dayLength = setToday - riseToday;
    progress = ((now - riseToday) / dayLength) * 100;
  } else {
    isDay = false;
    nextEventLabel = "Sunrise";
    nextEventTime = riseTomorrow;
    const nightLength = riseTomorrow - setToday;
    progress = ((now - setToday) / nightLength) * 100;
  }
  progress = Math.min(Math.max(progress, 0), 100);

  return (
    <DataCard className="w-full space-y-3 shadow-lg">
      <div className="flex items-center justify-between opacity-80">
         <div className="flex items-center gap-2">
            {isDay ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-blue-300" />}
            <span className="text-[9px] uppercase font-bold tracking-widest">{isDay ? "Daylight" : "Night Ops"}</span>
         </div>
         <span className="text-[10px] font-mono opacity-60">
           {formatTime(new Date(nextEventTime).toISOString())} {nextEventLabel === "Sunset" ? "SET" : "RISE"}
         </span>
      </div>
      <div className="relative w-full h-1.5 bg-black/60 rounded-full overflow-hidden border border-white/5">
         <div className={`absolute top-0 bottom-0 left-0 shadow-[0_0_8px_rgba(255,255,255,0.4)] ${isDay ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${progress}%`, transition: 'width 1s linear' }} />
      </div>
      <div className="flex justify-between text-[8px] font-mono text-muted-foreground uppercase">
         <div className="flex items-center gap-1"><Sunrise className="w-3 h-3" /> {formatTime(sunrise[0])}</div>
         <div className="flex items-center gap-1">{formatTime(sunset[0])} <Sunset className="w-3 h-3" /></div>
      </div>
    </DataCard>
  );
});
SolarCard.displayName = "SolarCard";

const CoordinateRow = memo(({ label, value, type }: { label: string; value: number; type: 'lat' | 'lng' }) => {
  const formattedValue = useMemo(() => formatCoordinate(value, type), [value, type]);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    triggerHaptic();
    if (!navigator.clipboard) return;
    try { 
      await navigator.clipboard.writeText(formattedValue); 
      setCopied(true); 
      setTimeout(() => setCopied(false), 2000); 
    } catch (e) { console.error(e); }
  };
  
  return (
    <button className="group w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-black/20 hover:bg-white/5 border border-transparent hover:border-white/5 active:scale-[0.99] transition-all touch-manipulation" onClick={handleCopy} type="button">
      <div className="flex flex-col items-start">
         <span className={`text-[8px] uppercase tracking-widest font-bold transition-colors ${copied ? "text-green-500" : "text-muted-foreground"}`}>{copied ? "COPIED" : label}</span>
         <span className="text-lg font-mono font-medium tracking-tight text-foreground tabular-nums mt-0.5">{formattedValue}</span>
      </div>
      <div className={`p-1.5 rounded-md transition-colors ${copied ? "bg-green-500/10 text-green-500" : "bg-transparent text-muted-foreground/30 group-hover:text-foreground"}`}>
          {copied ? <div className="w-1.5 h-1.5 rounded-full bg-green-500" /> : <Maximize2 className="w-3 h-3" />}
      </div>
    </button>
  );
});
CoordinateRow.displayName = "CoordinateRow";

const FullMapDrawer = memo(({ isOpen, onClose, lat, lng }: { isOpen: boolean, onClose: () => void, lat: number, lng: number }) => {
  const [copied, setCopied] = useState(false);
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const marker = useRef<mapboxgl.Marker | null>(null);
  const [zoomLevel, setZoomLevel] = useState(16);

  useEffect(() => {
    if (!isOpen || !mapContainer.current || map.current) return; 

    try {
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/satellite-streets-v12',
        center: [lng, lat],
        zoom: 16,
        attributionControl: false
      });
      map.current.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
      const el = document.createElement('div');
      el.className = 'marker';
      el.innerHTML = `<div style="position: relative; width: 20px; height: 20px; display: flex; justify-content: center; align-items: center;"><div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; background-color: rgba(34, 197, 94, 0.5); animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></div><div style="width: 10px; height: 10px; background-color: #22c55e; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px rgba(34,197,94,0.8);"></div></div>`;
      marker.current = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map.current);
      map.current.on('zoom', () => { if(map.current) setZoomLevel(map.current.getZoom()); });
    } catch (e) { console.error("Map initialization failed", e); }
  }, [isOpen]);

  useEffect(() => {
    return () => { if (map.current) { map.current.remove(); map.current = null; } };
  }, []);

  useEffect(() => {
    if (!map.current) return;
    if (marker.current) marker.current.setLngLat([lng, lat]);
    const currentCenter = map.current.getCenter();
    const dist = getDistance(currentCenter.lat, currentCenter.lng, lat, lng);
    if (dist > 100) map.current.flyTo({ center: [lng, lat], speed: 0.8 });
  }, [lat, lng]);

  useEffect(() => {
    if (isOpen && map.current) {
      setTimeout(() => { map.current?.resize(); map.current?.flyTo({ center: [lng, lat] }); }, 300); 
    }
  }, [isOpen]);

  const handleCopy = () => {
    if(navigator.clipboard) {
       navigator.clipboard.writeText(`${lat}, ${lng}`);
       setCopied(true);
       setTimeout(() => setCopied(false), 2000);
       triggerHaptic();
    }
  };
  const zoomIn = () => { triggerHaptic(); map.current?.zoomIn(); };
  const zoomOut = () => { triggerHaptic(); map.current?.zoomOut(); };
  const resetView = () => { triggerHaptic(); map.current?.flyTo({ center: [lng, lat], zoom: 16, bearing: 0, pitch: 0 }); };

  return (
    <>
      <div className={`fixed inset-0 bg-black/90 backdrop-blur-sm z-[60] transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      <div className={`fixed bottom-0 left-0 right-0 h-[92dvh] bg-[#0c0c0c] border-t border-white/10 rounded-t-[2rem] shadow-2xl z-[61] transition-transform duration-500 cubic-bezier(0.32, 0.72, 0, 1) flex flex-col ${isOpen ? 'translate-y-0' : 'translate-y-full'}`}>
        <div className="absolute top-0 left-0 right-0 z-[65] p-6 pt-8 flex justify-between items-start pointer-events-none bg-gradient-to-b from-black/80 to-transparent">
            <div className="pointer-events-auto space-y-1">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_#22c55e]" />
                    <h3 className="text-xl font-black text-white tracking-widest uppercase font-mono">Sat<span className="text-white/40">.Link</span></h3>
                </div>
                <button onClick={handleCopy} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 active:scale-95 transition-all group">
                    <span className={`text-[10px] font-mono tracking-wider ${copied ? 'text-green-400' : 'text-white/60 group-hover:text-white'}`}>{lat.toFixed(6)}, {lng.toFixed(6)}</span>
                    {copied ? <Check className="w-3 h-3 text-green-400"/> : <Copy className="w-3 h-3 text-white/40 group-hover:text-white"/>}
                </button>
            </div>
            <button onClick={onClose} className="pointer-events-auto p-3 rounded-full bg-white/5 border border-white/10 text-white hover:bg-white/10 active:scale-90 transition-all backdrop-blur-md"><X className="w-5 h-5" /></button>
        </div>
        <div className="relative flex-1 w-full h-full overflow-hidden bg-[#111]" ref={mapContainer}>
           <div className="absolute inset-0 flex items-center justify-center -z-10"><Loader2 className="w-8 h-8 animate-spin text-green-500/50" /></div>
           <div className="absolute inset-0 pointer-events-none z-10 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        </div>
        <div className="absolute right-4 top-1/2 -translate-x-1/2 z-[65] flex flex-col gap-4 pointer-events-none">
             <div className="pointer-events-auto flex flex-col gap-2 bg-black/40 backdrop-blur-md p-1.5 rounded-2xl border border-white/10">
                 <button onClick={zoomIn} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors"><Plus className="w-5 h-5"/></button>
                 <button onClick={resetView} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors text-[10px] font-bold font-mono">{Math.round(zoomLevel)}z</button>
                 <button onClick={zoomOut} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors"><Minus className="w-5 h-5"/></button>
             </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 z-[65] p-6 bg-gradient-to-t from-black via-black/90 to-transparent">
             <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
                 <button onClick={() => window.open(`http://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}`, '_blank')} className="flex items-center justify-center gap-2 py-4 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 text-white font-bold text-xs uppercase tracking-wider backdrop-blur-md transition-all active:scale-[0.98]">
                    <MapPin className="w-4 h-4" /> Apple Maps
                 </button>
                 <button onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank')} className="flex items-center justify-center gap-2 py-4 rounded-xl bg-[#4285F4]/20 hover:bg-[#4285F4]/30 border border-[#4285F4]/30 text-[#4285F4] font-bold text-xs uppercase tracking-wider backdrop-blur-md transition-all active:scale-[0.98]">
                    <LocateFixed className="w-4 h-4" /> Google Maps
                 </button>
             </div>
        </div>
      </div>
    </>
  );
});
FullMapDrawer.displayName = "FullMapDrawer";

// --- MAIN COMPONENT ---
export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { heading, trueHeading, pitch, roll, requestAccess, permissionGranted, error: compassError } = useCompass();
  useWakeLock();

  const [address, setAddress] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [path, setPath] = useState<GeoPoint[]>([]);
  const [units, setUnits] = useState<UnitSystem>('metric');
  const [mapMode, setMapMode] = useState<MapMode>('heading-up');
  const [lastApiFetch, setLastApiFetch] = useState<{lat: number, lng: number} | null>(null);
  const [mounted, setMounted] = useState(false);
  const [isMapDrawerOpen, setIsMapDrawerOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedPath, setRecordedPath] = useState<GeoPoint[]>([]);
  const [showSaveButton, setShowSaveButton] = useState(false);
  const [isGestureMode, setIsGestureMode] = useState(false);
  
  const isMountedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => { 
    isMountedRef.current = true;
    setMounted(true); 
    return () => { isMountedRef.current = false; };
  }, []);

  const isMoving = (coords?.speed ?? 0) > GPS_HEADING_THRESHOLD;
  const effectiveHeading = isMoving && coords?.heading !== null && coords?.heading !== undefined ? coords.heading : (heading ?? 0);
  const effectiveTrueHeading = isMoving && coords?.heading !== null && coords?.heading !== undefined ? coords.heading : trueHeading;

  useEffect(() => {
    if (!coords) return;
    const newPoint = { lat: coords.latitude, lng: coords.longitude, alt: coords.altitude, timestamp: Date.now() };

    setPath(prev => {
      if (prev.length === 0) return [newPoint];
      const last = prev[prev.length - 1];
      const distance = getDistance(last.lat, last.lng, coords.latitude, coords.longitude);
      if (distance > TRAIL_MIN_DISTANCE) {
        const newPath = [...prev, newPoint];
        return newPath.length > TRAIL_MAX_POINTS ? newPath.slice(newPath.length - TRAIL_MAX_POINTS) : newPath;
      }
      return prev;
    });

    if (isRecording) {
      setRecordedPath(prev => {
        if (prev.length === 0) return [newPoint];
        const last = prev[prev.length - 1];
        const dist = getDistance(last.lat, last.lng, newPoint.lat, newPoint.lng);
        if (dist >= REC_MIN_DISTANCE) return [...prev, newPoint];
        return prev;
      });
    }
  }, [coords, isRecording]);

  const toggleRecording = useCallback(() => {
    triggerHaptic();
    if (isRecording) {
      setIsRecording(false);
      if (recordedPath.length > 0) setShowSaveButton(true);
    } else {
      setRecordedPath([]); 
      setShowSaveButton(false);
      setIsRecording(true);
    }
  }, [isRecording, recordedPath]);

  const downloadGPX = useCallback(() => {
    triggerHaptic();
    if (recordedPath.length === 0) return;
    const gpxString = generateGPX(recordedPath);
    const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission-log-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowSaveButton(false); 
  }, [recordedPath]);

  const handleShare = async () => {
    triggerHaptic();
    if (!coords) return;
    const text = `Lat: ${coords.latitude.toFixed(6)}, Lng: ${coords.longitude.toFixed(6)}`;
    const url = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'My Location', text, url }); } catch (err) { console.error(err); }
    } else {
      navigator.clipboard.writeText(`${text}\n${url}`);
    }
  };

  const recenterMap = useCallback(() => { if (coords) setPath([{ lat: coords.latitude, lng: coords.longitude, alt: coords.altitude, timestamp: Date.now() }]); }, [coords]);
  const toggleUnits = useCallback(() => { triggerHaptic(); setUnits(prev => prev === 'metric' ? 'imperial' : 'metric'); }, []);
  const toggleMapMode = useCallback(() => setMapMode(prev => prev === 'heading-up' ? 'north-up' : 'heading-up'), []);
  const debouncedCoords = useDebounce(coords, 2000);

  useEffect(() => {
    if (!debouncedCoords) return;
    if (lastApiFetch) {
        const distKm = getDistance(lastApiFetch.lat, lastApiFetch.lng, debouncedCoords.latitude, debouncedCoords.longitude) / 1000;
        if (distKm < API_FETCH_DISTANCE_THRESHOLD && address && weather) return;
    }
    
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    
    const fetchData = async () => {
      try {
        const { latitude, longitude } = debouncedCoords;
        const signal = abortControllerRef.current?.signal;
        const [geoRes, weatherRes] = await Promise.allSettled([
          fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14`, { signal }),
          fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset&forecast_days=2&timezone=auto`, { signal })
        ]);
        
        if (signal?.aborted || !isMountedRef.current) return;

        if (geoRes.status === 'fulfilled' && geoRes.value.ok) {
          try {
            const data = await geoRes.value.json();
            const addr = data.address;
            if (addr) {
              const location = [addr.city, addr.town, addr.village, addr.suburb].find(v => v) || "Wilderness";
              setAddress(addr.country_code ? `${location}, ${addr.country_code.toUpperCase()}` : location);
            }
          } catch (e) {}
        }

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
          try {
            const data = await weatherRes.value.json();
            const info = getWeatherInfo(data.current.weather_code);
            setWeather({ 
              temp: data.current.temperature_2m, 
              code: data.current.weather_code, 
              description: info.label,
              windSpeed: data.current.wind_speed_10m,
              windDir: data.current.wind_direction_10m,
              sunrise: data.daily.sunrise,
              sunset: data.daily.sunset
            });
          } catch (e) {}
        }
        setLastApiFetch({ lat: latitude, lng: longitude });
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') console.error(err);
      }
    };
    fetchData();
  }, [debouncedCoords, lastApiFetch, address, weather]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;
  const recordedDistance = useMemo(() => {
     if (!isRecording && recordedPath.length === 0) return 0;
     const dist = calculateTotalDistance(recordedPath);
     return units === 'metric' ? dist : dist * 3.28084;
  }, [recordedPath, isRecording, units]);

  if (!mounted) return null;

  return (
    <main className="relative flex flex-col items-center min-h-[100dvh] w-full bg-[#050505] text-foreground p-4 md:p-8 overflow-x-hidden touch-manipulation font-sans selection:bg-green-500/30 pb-32">
      <div className="absolute inset-0 pointer-events-none z-0">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,197,94,0.08),transparent_50%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] opacity-20" />
      </div>

      <div className="w-full max-w-5xl flex justify-between items-center z-40 mb-8 shrink-0">
         <div className="flex flex-col">
             <div className="flex items-center gap-2">
                 <Scan className="w-4 h-4 text-green-500" />
                 <h1 className="text-sm font-black tracking-[0.2em] text-white/80 uppercase">Field<span className="text-white/30">Nav</span></h1>
             </div>
             <div className="flex items-center gap-1.5 mt-1 ml-0.5">
                 <div className={`w-1.5 h-1.5 rounded-full ${coords ? "bg-green-500 shadow-[0_0_5px_#22c55e]" : "bg-red-500"}`} />
                 <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{coords ? "Online" : "Searching"}</span>
             </div>
         </div>

         <div className="flex gap-3 items-center">
            {isRecording && (
               <div className="hidden md:flex flex-col items-end mr-2 animate-in fade-in slide-in-from-right-4">
                 <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Distance</span>
                 <span className="text-sm font-mono font-bold text-red-400 tabular-nums leading-none">
                   {(recordedDistance / (units === 'metric' ? 1000 : 5280)).toFixed(2)}<span className="text-[10px] ml-1">{units === 'metric' ? 'km' : 'mi'}</span>
                 </span>
               </div>
            )}
            <button onClick={toggleRecording} className={`group flex items-center gap-2 px-4 py-2 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${isRecording ? "bg-red-500/10 border-red-500/50 text-red-500 shadow-[0_0_10px_rgba(239,68,68,0.2)]" : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-white"}`}>
               {isRecording ? <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> : <Circle className="w-2 h-2 group-hover:text-white transition-colors" />}
               {isRecording ? "REC" : "LOG"}
            </button>
            <button onClick={toggleUnits} className="px-3 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-all active:scale-95">
               {units === 'metric' ? 'MET' : 'IMP'}
            </button>
            <button onClick={() => setIsGestureMode(!isGestureMode)} className={`p-2 rounded-full border text-[10px] transition-all active:scale-95 ${isGestureMode ? "bg-green-500/10 border-green-500/50 text-green-500" : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"}`}>
               {isGestureMode ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            </button>
         </div>
      </div>

      {isGestureMode && <GestureOps onToggleRecording={toggleRecording} onToggleMapMode={toggleMapMode} isRecording={isRecording} />}

      <div className="w-full max-w-5xl flex flex-col items-center justify-start space-y-6 z-10">
        {loading && !coords && (
          <div className="flex flex-col items-center justify-center h-64 space-y-6 animate-pulse">
            <Loader2 className="w-8 h-8 animate-spin text-green-500/50" />
            <span className="text-xs tracking-[0.3em] uppercase text-green-500/70 font-bold">Acquiring Satellites...</span>
          </div>
        )}

        {error && !coords && (
           <Alert variant="destructive" className="max-w-md bg-red-950/20 border-red-900/50 text-red-200">
             <AlertCircle className="h-4 w-4" />
             <AlertTitle>Signal Error</AlertTitle>
             <AlertDescription>{error}. Check device location settings.</AlertDescription>
           </Alert>
        )}

        {showSaveButton && !isRecording && (
          <div className="w-full max-w-md animate-in slide-in-from-top-4 fade-in">
             <button onClick={downloadGPX} className="w-full py-4 rounded-xl bg-green-500 text-black font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(34,197,94,0.4)] flex items-center justify-center gap-2 active:scale-95 transition-transform hover:bg-green-400">
                <Download className="w-5 h-5" /> Download Log
             </button>
          </div>
        )}

        {coords && (
          <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
             <div className="lg:col-span-4 flex flex-col gap-4 order-2 lg:order-1">
                 <DataCard className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest flex items-center gap-2">
                           <MapPin className="w-3 h-3 text-green-500" /> Coordinates
                        </span>
                        <div className="flex gap-2">
                          <button onClick={handleShare} className="p-1.5 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors"><Share2 className="w-3.5 h-3.5" /></button>
                          <div className="flex items-center gap-1 px-2 py-1 bg-black/40 rounded border border-white/10">
                             <Signal className={`w-3 h-3 ${(coords.accuracy || 100) < 15 ? 'text-green-500' : (coords.accuracy || 100) < 50 ? 'text-yellow-500' : 'text-red-500'}`} />
                             <span className="text-[9px] font-mono font-bold text-white/70">GPS</span>
                          </div>
                        </div>
                    </div>
                    <div className="space-y-2">
                       <CoordinateRow label="LAT" value={coords.latitude} type="lat" />
                       <CoordinateRow label="LNG" value={coords.longitude} type="lng" />
                    </div>
                    <button onClick={() => { triggerHaptic(); setIsMapDrawerOpen(true); }} className="w-full py-3 rounded-lg bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 text-green-500 text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-[0.98]">
                      Expand Map View
                    </button>
                 </DataCard>

                 <div className="grid grid-cols-3 gap-3 h-24">
                    <StatCard icon={Mountain} label="ALT" value={convertAltitude(coords.altitude, units)} unit={units === 'metric' ? 'm' : 'ft'} />
                    <StatCard icon={Activity} label="SPD" value={convertSpeed(coords.speed, units)} unit={units === 'metric' ? 'kph' : 'mph'} />
                    <StatCard icon={Navigation} label="ACC" value={coords.accuracy ? `±${Math.round(coords.accuracy)}` : '--'} unit="m" />
                 </div>

                 {weather && weather.sunrise && <SolarCard sunrise={weather.sunrise} sunset={weather.sunset} />}
                 
                 {weather && (
                   <DataCard className="flex items-center justify-between !p-0 overflow-hidden bg-gradient-to-r from-blue-950/30 to-transparent">
                      <div className="flex items-center gap-4 p-4">
                          <div className="p-2.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20"><WeatherIcon className="w-5 h-5" /></div>
                          <div className="flex flex-col">
                             <span className="text-2xl font-mono font-bold tabular-nums leading-none tracking-tight">{convertTemp(weather.temp, units)}</span>
                             <div className="flex items-center gap-2 mt-1.5">
                               <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wide">{weather.description}</span>
                               <span className="text-[9px] text-muted-foreground/30">|</span>
                               <div className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground"><Wind className="w-3 h-3" />{convertSpeed(weather.windSpeed / 3.6, units)}</div>
                             </div>
                          </div>
                      </div>
                      <div className="h-full px-4 border-l border-white/5 flex items-center justify-center bg-white/2">
                         <span className="text-[9px] uppercase font-black text-muted-foreground rotate-180" style={{ writingMode: 'vertical-rl' }}>{address ? address.split(',')[0].slice(0, 12) : "LOCAL"}</span>
                      </div>
                   </DataCard>
                 )}
             </div>

             <div className="lg:col-span-8 flex flex-col items-center justify-center order-1 lg:order-2">
                 <div className="relative w-full flex flex-col items-center justify-center py-6 gap-6 md:gap-8">
                     <div className="absolute inset-y-0 left-1/2 w-px bg-gradient-to-b from-transparent via-white/10 to-transparent -z-10" />
                     <CompassDisplay 
                        heading={effectiveHeading} 
                        trueHeading={effectiveTrueHeading} 
                        onClick={requestAccess} 
                        hasError={!!compassError} 
                        permissionGranted={permissionGranted}
                        source={isMoving ? 'GPS' : 'MAG'}
                     />
                     <div className="relative z-10">
                         <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-px h-8 bg-gradient-to-b from-white/10 to-white/30" />
                         <Inclinometer pitch={pitch} roll={roll} />
                         <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-px h-8 bg-gradient-to-t from-white/10 to-white/30" />
                     </div>
                     <div className="flex flex-col items-center gap-4 relative z-10 mt-2">
                        <RadarMapbox 
                          path={path} 
                          lat={coords.latitude} 
                          lng={coords.longitude} 
                          heading={effectiveHeading || 0}
                          mode={mapMode}
                          accuracy={coords.accuracy}
                          zoom={RADAR_ZOOM}
                          onRecenter={recenterMap}
                          onToggleMode={toggleMapMode}
                        />
                        {path.length > 1 && (
                          <button onClick={() => { triggerHaptic(); recenterMap(); }} className="mt-8 text-[8px] text-muted-foreground hover:text-red-400 uppercase tracking-widest font-bold flex items-center gap-2 transition-colors py-1.5 px-3 rounded-full hover:bg-white/5 border border-transparent hover:border-red-500/20">
                            <Trash2 className="w-3 h-3" /> Clear Trail
                          </button>
                        )}
                     </div>
                 </div>
             </div>
          </div>
        )}
      </div>
      {coords && <FullMapDrawer isOpen={isMapDrawerOpen} onClose={() => setIsMapDrawerOpen(false)} lat={coords.latitude} lng={coords.longitude} />}
    </main>
  );
}