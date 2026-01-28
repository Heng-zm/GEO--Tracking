
"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, Loader2,
  Trash2, Crosshair, Compass as CompassIcon, WifiOff,
  Maximize2, X, ExternalLink, LocateFixed, Circle, Download, Sunrise, Sunset, Moon, Wind,
  Plus, Minus
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- Configuration ---
const MAPBOX_TOKEN = "pk.eyJ1Ijoib3BlbnN0cmVldGNhbSIsImEiOiJja252Ymh4ZnIwNHdkMnd0ZzF5NDVmdnR5In0.dYxz3TzZPTPzd_ibMeGK2g";
const RADAR_ZOOM = 18;
const TRAIL_MAX_POINTS = 100; // Visual trail only
const TRAIL_MIN_DISTANCE = 5; 
const MAP_UPDATE_THRESHOLD = 40; 
const API_FETCH_DISTANCE_THRESHOLD = 0.5; 

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
  sunrise: string[]; // Array of ISO strings (Today, Tomorrow)
  sunset: string[];  // Array of ISO strings (Today, Tomorrow)
};

type GeoPoint = { lat: number; lng: number; alt: number | null; timestamp: number };

type UnitSystem = 'metric' | 'imperial';

type MapMode = 'heading-up' | 'north-up';

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const triggerHaptic = () => {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(15);
    }
  } catch (e) {}
};

const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(6)}°${direction}`;
};

const convertSpeed = (ms: number | null, system: UnitSystem): string => {
  if (ms === null || ms < 0) return "0.0";
  return system === 'metric' 
    ? `${(ms * 3.6).toFixed(1)}` 
    : `${(ms * 2.23694).toFixed(1)}`;
};

const convertAltitude = (meters: number | null, system: UnitSystem): string => {
  if (meters === null) return "--";
  return system === 'metric'
    ? `${Math.round(meters)}`
    : `${Math.round(meters * 3.28084)}`;
};

const convertTemp = (celsius: number, system: UnitSystem): string => {
  return system === 'metric'
    ? `${celsius.toFixed(1)}°`
    : `${((celsius * 9/5) + 32).toFixed(1)}°`;
};

const formatTime = (isoString: string) => {
  if (!isoString) return "--:--";
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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

// GPX Generator
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
  useEffect(() => {
    let wakeLock: any = null;
    
    const requestLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        // Wake lock denied or not supported
      }
    };

    requestLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (wakeLock) wakeLock.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
};

const useGeolocation = () => {
  const [state, setState] = useState<GeoState>({ coords: null, error: null, loading: true });
  const lastUpdate = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setState({ coords: null, loading: false, error: "Geolocation not supported" });
      return;
    }

    const handleSuccess = ({ coords }: GeolocationPosition) => {
      const now = Date.now();
      // Throttle updates slightly to prevent render thrashing
      if (now - lastUpdate.current < 500) return;
      if (isNaN(coords.latitude) || isNaN(coords.longitude)) return;
      lastUpdate.current = now;

      setState(prev => {
        // Deep comparison to avoid unnecessary state updates
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.speed === coords.speed &&
            prev.coords.heading === coords.heading &&
            prev.coords.accuracy === coords.accuracy) {
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
    };

    const handleError = (error: GeolocationPositionError) => {
      let errorMessage = "Signal Lost";
      switch(error.code) {
        case error.PERMISSION_DENIED: errorMessage = "Location denied"; break;
        case error.POSITION_UNAVAILABLE: errorMessage = "Position unavailable"; break;
        case error.TIMEOUT: return;
      }
      setState(s => ({ ...s, loading: false, error: errorMessage }));
    };

    const watcher = navigator.geolocation.watchPosition(
      handleSuccess, handleError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
    );

    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  return state;
};

const useCompass = () => {
  const [visualHeading, setVisualHeading] = useState<number | null>(null);
  const [trueHeading, setTrueHeading] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<number>(0);
  const currentRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);
  const isAnimating = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS)?.requestPermission === 'function';
      if (!isIOS) setPermissionGranted(true);
    }
  }, []);

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
    } else { setPermissionGranted(true); }
  }, []);

  // Animation Loop for Smooth Compass
  useEffect(() => {
    if (!permissionGranted) return;
    const loop = () => {
      const diff = targetRef.current - currentRef.current;
      
      // Stop animation if close enough
      if (Math.abs(diff) < 0.1) {
         isAnimating.current = false;
         if (currentRef.current !== targetRef.current) {
            currentRef.current = targetRef.current;
            setVisualHeading((currentRef.current % 360 + 360) % 360);
         }
         return;
      }
      
      // Interpolate
      currentRef.current += diff * 0.15;
      setVisualHeading((currentRef.current % 360 + 360) % 360);
      rafIdRef.current = requestAnimationFrame(loop);
    };

    if (isAnimating.current) rafIdRef.current = requestAnimationFrame(loop);
    return () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
  }, [permissionGranted, trueHeading]);

  useEffect(() => {
    if (!permissionGranted || typeof window === 'undefined') return;
    const handleOrientation = (e: any) => {
      let degree: number | null = null;
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        degree = e.webkitCompassHeading;
      } else if (e.alpha !== null) {
        degree = Math.abs(360 - e.alpha);
      }
      if (degree !== null) {
        const normalized = ((degree) + 360) % 360;
        setTrueHeading(normalized);
        
        // Shortest path interpolation logic
        const current = targetRef.current;
        const currentMod = (current % 360 + 360) % 360;
        let delta = normalized - currentMod;
        
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        
        if (Math.abs(delta) > 0.5) {
          targetRef.current = current + delta;
          if (!isAnimating.current) {
             isAnimating.current = true;
             rafIdRef.current = requestAnimationFrame(() => {
                 // Restart loop if it was stopped
                 const diff = targetRef.current - currentRef.current;
                 currentRef.current += diff * 0.15;
                 setVisualHeading((currentRef.current % 360 + 360) % 360);
                 if (Math.abs(diff) > 0.1) isAnimating.current = true; 
             });
          }
        }
      }
    };
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handleOrientation, true);
    return () => window.removeEventListener(eventName, handleOrientation, true);
  }, [permissionGranted]);

  return { heading: visualHeading, trueHeading, requestAccess, permissionGranted, error };
};

const useDebounce = <T,>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
};

// --- UI Components ---

const RadarMapbox = memo(({ 
  path, 
  heading, 
  lat, 
  lng,
  mode,
  onRecenter,
  onToggleMode
}: { 
  path: GeoPoint[], 
  heading: number, 
  lat: number, 
  lng: number,
  mode: MapMode,
  onRecenter: () => void,
  onToggleMode: () => void
}) => {
  const [anchor, setAnchor] = useState({ lat, lng });
  const [isOffCenter, setIsOffCenter] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);

  useEffect(() => {
    const distance = getDistance(anchor.lat, anchor.lng, lat, lng);
    setIsOffCenter(distance > 10);
    if (distance > MAP_UPDATE_THRESHOLD) {
      setAnchor({ lat, lng });
      setImgLoaded(false);
      setMapError(false);
    }
  }, [lat, lng, anchor]);

  const mapUrl = useMemo(() => 
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${anchor.lng},${anchor.lat},${RADAR_ZOOM},0,0/500x500@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, 
  [anchor.lat, anchor.lng]);

  const { userX, userY, svgPath } = useMemo(() => {
    const userPos = geoToPixels(lat, lng, anchor.lat, anchor.lng, RADAR_ZOOM);
    let pathD = "";
    if (path.length > 1) {
      const points = path.map(p => {
        const pt = geoToPixels(p.lat, p.lng, anchor.lat, anchor.lng, RADAR_ZOOM);
        return `${pt.x},${pt.y}`;
      });
      pathD = "M " + points.join(" L ");
    }
    return { userX: userPos.x, userY: userPos.y, svgPath: pathD };
  }, [lat, lng, anchor, path]);

  const rotation = mode === 'heading-up' ? heading : 0;
  const markerRotation = mode === 'heading-up' ? 0 : heading;

  return (
    <div className="relative w-60 h-60 md:w-80 md:h-80 shrink-0 transition-all duration-300">
      <div className="absolute inset-0 rounded-full border border-border/20 bg-background/50 backdrop-blur-3xl shadow-2xl z-0" />
      <div className="w-full h-full relative isolate">
        
        <div 
          className="absolute inset-0 rounded-full overflow-hidden bg-black z-0"
          style={{ 
             WebkitMaskImage: '-webkit-radial-gradient(white, black)',
             maskImage: 'radial-gradient(white, black)',
             transform: 'translateZ(0)'
          }}
        >
          <div 
            className="w-full h-full absolute inset-0 will-change-transform transition-transform duration-100 ease-linear origin-center"
            style={{ transform: `rotate(${-rotation}deg) scale(1.02)` }} 
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[220%] h-[220%]">
               <div className="absolute inset-0 bg-[#0a0f0a]" />
               <div className={`absolute inset-0 opacity-15 transition-opacity duration-300 ${(!imgLoaded || mapError) ? 'opacity-30' : ''}`}
                 style={{ 
                   backgroundImage: 'linear-gradient(#22c55e 1px, transparent 1px), linear-gradient(90deg, #22c55e 1px, transparent 1px)', 
                   backgroundSize: '40px 40px' 
                 }} 
               />
               {!mapError && (
                 <img
                   src={mapUrl}
                   alt="Satellite View"
                   onLoad={() => setImgLoaded(true)}
                   onError={() => setMapError(true)}
                   className={`w-full h-full object-contain transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                   style={{ filter: 'grayscale(0.3) contrast(1.1) brightness(0.8)' }}
                 />
               )}
            </div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] pointer-events-none z-10">
              <svg viewBox="-200 -200 400 400" className="w-full h-full overflow-visible">
                {svgPath && (
                  <path d={svgPath} fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                )}
                <g transform={`translate(${userX}, ${userY})`}>
                   <g transform={`rotate(${markerRotation})`}>
                      <path d="M -6 -6 L 0 -18 L 6 -6" fill="rgba(34,197,94,0.8)" />
                      <circle r="5" fill="#22c55e" className="animate-pulse" />
                      <circle r="8" fill="none" stroke="#ffffff" strokeWidth="2" className="opacity-90" />
                   </g>
                </g>
              </svg>
            </div>
          </div>
        </div>

        <div className="absolute inset-0 rounded-full border-4 border-muted/20 pointer-events-none z-10" />
        <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 mix-blend-overlay z-20 rounded-full" />
        <div className="absolute inset-0 pointer-events-none z-20 shadow-[inset_0_0_40px_rgba(0,0,0,0.8)] rounded-full" />
        <div className="absolute inset-0 rounded-full pointer-events-none overflow-hidden z-20">
             <div className="absolute inset-0 bg-[conic-gradient(from_0deg,transparent_0deg,transparent_280deg,rgba(34,197,94,0.15)_360deg)] animate-[spin_4s_linear_infinite]" />
        </div>

        <div className="absolute inset-0 pointer-events-none z-30">
           <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 opacity-50">
              <div className="absolute top-1/2 left-0 w-2 h-px bg-green-500" />
              <div className="absolute top-1/2 right-0 w-2 h-px bg-green-500" />
              <div className="absolute top-0 left-1/2 h-2 w-px bg-green-500" />
              <div className="absolute bottom-0 left-1/2 h-2 w-px bg-green-500" />
           </div>
          <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[10px] font-black text-red-500 bg-black/50 px-2 rounded-full backdrop-blur-sm border border-red-500/30"
               style={{ transform: `rotate(${-rotation}deg)`, transformOrigin: 'center 110px' }}>N</div>
        </div>
        
        {imgLoaded && !mapError && (
          <div className="absolute bottom-3 right-4 text-[8px] font-black tracking-widest text-white/40 z-30 font-mono">SAT FEED</div>
        )}

        <button
           onClick={() => { triggerHaptic(); onToggleMode(); }}
           type="button"
           className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-bold tracking-widest text-green-400 bg-black/80 px-3 py-1.5 rounded-sm backdrop-blur-md z-40 border border-green-500/30 shadow-lg pointer-events-auto active:scale-95 active:bg-green-900/50 transition-all touch-manipulation"
        >
          {mode === 'heading-up' ? 'HDG UP' : 'NTH UP'}
        </button>
      </div>

      {isOffCenter && (
        <button 
          onClick={() => { triggerHaptic(); onRecenter(); }}
          type="button"
          className="absolute -bottom-10 left-1/2 -translate-x-1/2 p-3 rounded-full bg-background border border-border/40 text-foreground hover:bg-muted transition-all duration-200 active:scale-95 shadow-xl z-30 touch-manipulation"
        >
          <Crosshair className="w-5 h-5" />
        </button>
      )}
    </div>
  );
});
RadarMapbox.displayName = "RadarMapbox";

const CompassTicks = memo(() => (
  <>
    <circle cx="50" cy="50" r="46" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/20 fill-none" />
    {[...Array(72)].map((_, i) => {
      const isCardinal = i % 18 === 0;
      const isMajor = i % 6 === 0;
      const length = isCardinal ? 6 : isMajor ? 4 : 2;
      const width = isCardinal ? 1.5 : isMajor ? 1 : 0.5;
      const colorClass = isCardinal ? "text-foreground" : isMajor ? "text-foreground/70" : "text-muted-foreground/30";
      return (
        <line key={i} x1="50" y1="5" x2="50" y2={5 + length} transform={`rotate(${i * 5} 50 50)`} stroke="currentColor" strokeWidth={width} className={colorClass} strokeLinecap="square" />
      );
    })}
    <text x="50" y="22" textAnchor="middle" className="text-[6px] font-black fill-red-500" transform="rotate(0 50 50)">N</text>
    <text x="50" y="22" textAnchor="middle" className="text-[5px] font-bold fill-foreground" transform="rotate(90 50 50)">E</text>
    <text x="50" y="22" textAnchor="middle" className="text-[5px] font-bold fill-foreground" transform="rotate(180 50 50)">S</text>
    <text x="50" y="22" textAnchor="middle" className="text-[5px] font-bold fill-foreground" transform="rotate(270 50 50)">W</text>
    <path d="M 48 50 L 52 50 M 50 48 L 50 52" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/50" />
  </>
));
CompassTicks.displayName = "CompassTicks";

const CompassDisplay = memo(({ 
  heading, 
  trueHeading, 
  onClick, 
  hasError, 
  permissionGranted 
}: { 
  heading: number | null, 
  trueHeading: number | null, 
  onClick: () => void, 
  hasError: boolean, 
  permissionGranted: boolean 
}) => {
  const rotation = heading || 0;
  const directionStr = trueHeading !== null ? getCompassDirection(trueHeading) : "--";
  const displayHeading = trueHeading !== null ? Math.round(trueHeading) : 0;

  return (
    <div className="flex flex-col items-center justify-center relative z-10 shrink-0">
      <div 
        className="relative w-56 h-56 md:w-64 md:h-64 cursor-pointer group select-none touch-manipulation transition-all duration-300" 
        onClick={onClick}
        role="button"
        aria-label="Calibrate Compass"
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex flex-col items-center">
          <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-red-500 drop-shadow-md translate-y-1" />
        </div>
        
        <div 
          className="w-full h-full will-change-transform transition-transform duration-75 ease-out rounded-full border border-border/10 bg-gradient-to-br from-background/80 to-background/40 backdrop-blur-sm shadow-xl"
          style={{ transform: `rotate(${-rotation}deg)` }}
        >
          <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none p-1">
            <CompassTicks />
          </svg>
        </div>

        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center z-20 pointer-events-none mix-blend-difference">
             <span className="text-4xl font-mono font-black tracking-tighter text-foreground tabular-nums">
                {permissionGranted ? `${displayHeading}°` : "--"}
             </span>
             <span className="text-[10px] font-bold text-muted-foreground tracking-[0.3em] uppercase">
                {permissionGranted ? directionStr : "---"}
             </span>
        </div>
        
        {!permissionGranted && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full z-30 bg-background/60 backdrop-blur-sm">
            <button type="button" className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-primary animate-pulse bg-background px-4 py-2 rounded-full border border-primary/20 shadow-xl">
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

const StatCard = memo(({ icon: Icon, label, value, subValue, unit }: { icon: any, label: string, value: string, subValue?: string, unit?: string }) => (
  <div className="flex flex-col items-start justify-between p-4 rounded-2xl bg-muted/5 border border-white/5 backdrop-blur-sm hover:bg-muted/10 transition-colors w-full min-w-[100px] h-full shadow-sm">
    <div className="flex w-full items-center justify-between mb-2 opacity-60">
      <span className="text-[10px] uppercase tracking-widest font-bold">{label}</span>
      <Icon className="w-3.5 h-3.5" />
    </div>
    <div className="flex flex-col items-baseline">
      <div className="flex items-baseline gap-1">
         <span className="text-xl md:text-2xl font-mono font-bold text-foreground tracking-tight tabular-nums">{value}</span>
         {unit && <span className="text-xs font-medium text-muted-foreground">{unit}</span>}
      </div>
      {subValue && <span className="text-[10px] text-muted-foreground font-medium">{subValue}</span>}
    </div>
  </div>
));
StatCard.displayName = "StatCard";

// Solar Intel Card with enhanced logic for next-day sunrise
const SolarCard = memo(({ sunrise, sunset }: { sunrise: string[], sunset: string[] }) => {
  const now = new Date().getTime();
  
  // Parse today's and tomorrow's events
  const riseToday = new Date(sunrise[0]).getTime();
  const setToday = new Date(sunset[0]).getTime();
  const riseTomorrow = new Date(sunrise[1]).getTime();

  let isDay = false;
  let nextEventLabel = "Sunrise";
  let nextEventTime = riseToday;
  let progress = 0;

  if (now < riseToday) {
    // Before dawn today
    isDay = false;
    nextEventLabel = "Sunrise";
    nextEventTime = riseToday;
    const nightLength = riseToday - (new Date(sunset[0]).getTime() - 86400000); // Approximate prev sunset
    progress = 100 - ((riseToday - now) / nightLength) * 100;
  } else if (now >= riseToday && now < setToday) {
    // Daytime
    isDay = true;
    nextEventLabel = "Sunset";
    nextEventTime = setToday;
    const dayLength = setToday - riseToday;
    progress = ((now - riseToday) / dayLength) * 100;
  } else {
    // After sunset today
    isDay = false;
    nextEventLabel = "Sunrise";
    nextEventTime = riseTomorrow;
    const nightLength = riseTomorrow - setToday;
    progress = ((now - setToday) / nightLength) * 100;
  }

  // Clamping
  progress = Math.min(Math.max(progress, 0), 100);

  return (
    <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-500/10 to-blue-900/10 border border-white/5 backdrop-blur-sm w-full shadow-sm space-y-3">
      <div className="flex items-center justify-between opacity-80">
         <div className="flex items-center gap-2">
            {isDay ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-blue-300" />}
            <span className="text-[10px] uppercase font-bold tracking-widest">{isDay ? "Daylight Ops" : "Night Ops"}</span>
         </div>
         <span className="text-[10px] font-mono opacity-60">
           {formatTime(new Date(nextEventTime).toISOString())} {nextEventLabel === "Sunset" ? "SET" : "RISE"}
         </span>
      </div>
      
      {/* Visual Day Progress */}
      <div className="relative w-full h-2 bg-black/40 rounded-full overflow-hidden">
         <div className={`absolute inset-0 opacity-20 ${isDay ? 'bg-gradient-to-r from-amber-900 via-amber-500 to-amber-900' : 'bg-gradient-to-r from-blue-900 via-blue-500 to-blue-900'}`} />
         <div 
            className={`absolute top-0 bottom-0 left-0 shadow-[0_0_10px_rgba(255,255,255,0.3)] ${isDay ? 'bg-amber-500' : 'bg-blue-500'}`} 
            style={{ width: `${progress}%` }}
         />
      </div>

      <div className="flex justify-between text-[9px] font-mono text-muted-foreground uppercase">
         <div className="flex items-center gap-1"><Sunrise className="w-3 h-3" /> {formatTime(sunrise[0])}</div>
         <div className="flex items-center gap-1">{formatTime(sunset[0])} <Sunset className="w-3 h-3" /></div>
      </div>
    </div>
  );
});
SolarCard.displayName = "SolarCard";

const CoordinateRow = memo(({ 
  label, 
  value, 
  type 
}: { 
  label: string; 
  value: number; 
  type: 'lat' | 'lng' 
}) => {
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
    <button 
      className="group w-full flex items-center justify-between px-4 py-3 rounded-xl bg-muted/10 border border-white/5 hover:bg-muted/20 active:scale-[0.98] transition-all touch-manipulation" 
      onClick={handleCopy}
      type="button"
    >
      <div className="flex flex-col items-start">
         <span className={`text-[9px] uppercase tracking-widest font-bold transition-colors ${copied ? "text-green-500" : "text-muted-foreground"}`}>
           {copied ? "COPIED" : label}
         </span>
         <span className="text-xl md:text-2xl font-mono font-medium tracking-tight text-foreground tabular-nums mt-0.5">
           {formattedValue}
         </span>
      </div>
      <div className={`p-2 rounded-full transition-colors ${copied ? "bg-green-500/20 text-green-500" : "bg-transparent text-muted-foreground/30 group-hover:text-foreground"}`}>
          {copied ? <div className="w-1.5 h-1.5 rounded-full bg-green-500" /> : <Maximize2 className="w-3 h-3" />}
      </div>
    </button>
  );
});
CoordinateRow.displayName = "CoordinateRow";

// --- FULL MAP DRAWER COMPONENT ---
const FullMapDrawer = memo(({ 
  isOpen, 
  onClose, 
  lat, 
  lng 
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  lat: number, 
  lng: number 
}) => {
  
  const [viewZoom, setViewZoom] = useState(15);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Generate Mapbox Static URL with Pin Overlay
  // Using satellite-streets-v12 style to match the rest of the app
  // Overlay: pin-l+ef4444 (large red pin)
  const mapUrl = useMemo(() => 
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/pin-l+ef4444(${lng},${lat})/${lng},${lat},${viewZoom},0,0/600x800@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, 
  [lat, lng, viewZoom]);

  const openAppleMaps = () => {
    window.open(`http://maps.apple.com/?q=${lat},${lng}`, '_blank');
  };

  const openGoogleMaps = () => {
    window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank');
  };

  const handleZoomIn = () => {
    triggerHaptic();
    setViewZoom(prev => Math.min(prev + 1, 20));
    setImgLoaded(false);
  };

  const handleZoomOut = () => {
    triggerHaptic();
    setViewZoom(prev => Math.max(prev - 1, 2));
    setImgLoaded(false);
  };

  return (
    <>
      <div 
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-50 transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} 
        onClick={onClose}
      />
      
      <div className={`fixed bottom-0 left-0 right-0 h-[85vh] bg-background/95 backdrop-blur-xl border-t border-border/20 rounded-t-3xl shadow-2xl z-[51] transition-transform duration-500 cubic-bezier(0.32, 0.72, 0, 1) ${isOpen ? 'translate-y-0' : 'translate-y-full'}`}>
        
        {/* Handle */}
        <div className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center z-[52] pointer-events-none" onClick={onClose}>
          <div className="w-12 h-1.5 bg-muted-foreground/20 rounded-full" />
        </div>

        {/* Map Header */}
        <div className="absolute top-4 left-6 z-[53] pointer-events-none">
            <h3 className="text-lg font-bold text-foreground/80 drop-shadow-md">Satellite View</h3>
            <p className="text-xs text-muted-foreground font-mono">{lat.toFixed(4)}, {lng.toFixed(4)}</p>
        </div>

        {/* Controls Overlay */}
        <div className="absolute top-4 right-4 z-[53] flex flex-col gap-2">
           <button onClick={onClose} className="p-3 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-white active:scale-95 transition-transform" aria-label="Close Map">
              <X className="w-5 h-5" />
           </button>
        </div>

        {/* Zoom Controls */}
        <div className="absolute top-1/2 right-4 -translate-y-1/2 z-[53] flex flex-col gap-2">
           <button onClick={handleZoomIn} className="p-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white active:scale-95 transition-transform shadow-lg">
              <Plus className="w-5 h-5" />
           </button>
           <button onClick={handleZoomOut} className="p-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white active:scale-95 transition-transform shadow-lg">
              <Minus className="w-5 h-5" />
           </button>
        </div>

        {/* Action Bar */}
        <div className="absolute bottom-8 left-4 right-4 z-[53] flex gap-3 pb-safe">
            <button onClick={openAppleMaps} className="flex-1 py-3 rounded-xl bg-white text-black font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2">
                <MapPin className="w-4 h-4" /> Apple Maps
            </button>
            <button onClick={openGoogleMaps} className="flex-1 py-3 rounded-xl bg-blue-600 text-white font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2">
                <LocateFixed className="w-4 h-4" /> Google Maps
            </button>
        </div>

        <div className="w-full h-full rounded-t-3xl overflow-hidden relative bg-[#1a1a1a] mt-0 pt-0">
          {isOpen && (
             <img
               src={mapUrl}
               alt="Mapbox Satellite View"
               onLoad={() => setImgLoaded(true)}
               className={`w-full h-full object-cover transition-opacity duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
               style={{ filter: 'grayscale(0.2) contrast(1.1) brightness(0.9)' }}
             />
          )}
          <div className="absolute inset-0 flex items-center justify-center -z-10">
             <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
          
          {/* Map Grid Overlay for aesthetics */}
          <div className="absolute inset-0 pointer-events-none opacity-20"
               style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '100px 100px' }} />
        </div>
      </div>
    </>
  );
});
FullMapDrawer.displayName = "FullMapDrawer";

export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { heading, trueHeading, requestAccess, permissionGranted, error: compassError } = useCompass();
  useWakeLock(); // Prevent screen sleep

  const [address, setAddress] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [path, setPath] = useState<GeoPoint[]>([]);
  const [units, setUnits] = useState<UnitSystem>('metric');
  const [mapMode, setMapMode] = useState<MapMode>('heading-up');
  const [lastApiFetch, setLastApiFetch] = useState<{lat: number, lng: number} | null>(null);
  const [mounted, setMounted] = useState(false);
  const [isMapDrawerOpen, setIsMapDrawerOpen] = useState(false);
  
  // -- New States for Recording --
  const [isRecording, setIsRecording] = useState(false);
  const [recordedPath, setRecordedPath] = useState<GeoPoint[]>([]);
  const [showSaveButton, setShowSaveButton] = useState(false);
  
  const isMountedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => { 
    isMountedRef.current = true;
    setMounted(true); 
    return () => { isMountedRef.current = false; };
  }, []);

  // Prevent accidental close while recording
  useEffect(() => {
    if (!isRecording) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRecording]);

  useEffect(() => {
    if (!coords) return;

    const newPoint = { 
      lat: coords.latitude, 
      lng: coords.longitude, 
      alt: coords.altitude, 
      // id removed to match GeoPoint type
      timestamp: Date.now() 
    };

    // Update visual path (limited trail)
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

    // Handle Background Recording (Unlimited trail)
    if (isRecording) {
      setRecordedPath(prev => [...prev, newPoint]);
    }

  }, [coords, isRecording]);

  const toggleRecording = useCallback(() => {
    triggerHaptic();
    if (isRecording) {
      // Stop recording
      setIsRecording(false);
      if (recordedPath.length > 0) setShowSaveButton(true);
    } else {
      // Start recording
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

  const resetRadar = useCallback(() => { 
    if (coords) setPath([{ lat: coords.latitude, lng: coords.longitude, alt: coords.altitude, timestamp: Date.now() }]); 
  }, [coords]);

  const recenterMap = useCallback(() => resetRadar(), [resetRadar]);
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
        
        // Fetch 2 days of daily data for solar cycle logic
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
              sunrise: data.daily.sunrise, // Array
              sunset: data.daily.sunset    // Array
            });
          } catch (e) {}
        }
        
        setLastApiFetch({ lat: latitude, lng: longitude });
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') console.error(err);
      }
    };
    fetchData();
    return () => { if (abortControllerRef.current) abortControllerRef.current.abort(); };
  }, [debouncedCoords, lastApiFetch, address, weather]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;
  if (!mounted) return null;

  return (
    <main className="relative flex flex-col items-center min-h-[100dvh] w-full bg-[#09090b] text-foreground p-4 md:p-8 overflow-x-hidden touch-manipulation font-sans selection:bg-green-500/30 pb-32">
      
      {/* Background Texture */}
      <div className="absolute inset-0 pointer-events-none z-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.05),transparent_70%)]" />
          <div className="absolute inset-0 opacity-[0.03]" 
               style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '50px 50px' }} />
      </div>

      {/* Header / Top Bar */}
      <div className="w-full max-w-5xl flex justify-between items-start z-40 mb-6 shrink-0">
         <div className="flex flex-col">
             <h1 className="text-xs font-black tracking-[0.3em] text-muted-foreground/60 uppercase">Field Navigation</h1>
             <div className="flex items-center gap-2 mt-1">
                 <div className={`w-2 h-2 rounded-full ${coords ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
                 <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{coords ? "Live Data" : "Offline"}</span>
             </div>
         </div>

         <div className="flex gap-2">
            {/* RECORD BUTTON */}
            <button
               onClick={toggleRecording}
               className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${
                 isRecording 
                   ? "bg-red-500/10 border-red-500/50 text-red-500" 
                   : "bg-white/5 border-white/5 text-muted-foreground hover:bg-white/10"
               }`}
            >
               {isRecording ? <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> : <Circle className="w-2 h-2" />}
               {isRecording ? "REC" : "LOG"}
            </button>

             <button 
               onClick={toggleUnits} 
               type="button"
               className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all active:scale-95"
             >
               {units === 'metric' ? 'MET' : 'IMP'}
             </button>
         </div>
      </div>

      <div className="w-full max-w-5xl flex flex-col items-center justify-start space-y-6 z-10">
        
        {loading && !coords && (
          <div className="flex flex-col items-center justify-center h-64 space-y-6 animate-pulse">
            <Loader2 className="w-8 h-8 animate-spin text-green-500/50" />
            <span className="text-xs tracking-[0.3em] uppercase text-green-500/70 font-bold">Initializing GPS...</span>
          </div>
        )}

        {error && !coords && (
           <Alert variant="destructive" className="max-w-md bg-red-950/20 border-red-900/50 text-red-200">
             <AlertCircle className="h-4 w-4" />
             <AlertTitle>GPS Signal Lost</AlertTitle>
             <AlertDescription>{error}. Check device permissions.</AlertDescription>
           </Alert>
        )}

        {/* SAVE GPX BUTTON OVERLAY */}
        {showSaveButton && !isRecording && (
          <div className="w-full max-w-md animate-in slide-in-from-top-4 fade-in">
             <button 
               onClick={downloadGPX}
               className="w-full py-4 rounded-xl bg-green-500 text-black font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(34,197,94,0.4)] flex items-center justify-center gap-2 active:scale-95 transition-transform"
             >
                <Download className="w-5 h-5" /> Download Mission Log
             </button>
          </div>
        )}

        {coords && (
          <div className="w-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
             
             {/* Left Column: Coordinates & Stats */}
             <div className="lg:col-span-4 flex flex-col gap-4 order-2 md:order-1">
                 
                 {/* Coordinates Module */}
                 <div className="bg-card/30 backdrop-blur-sm border border-white/5 rounded-3xl p-5 space-y-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Position</span>
                        <MapPin className="w-3 h-3 text-green-500" />
                    </div>
                    <CoordinateRow label="Latitude" value={coords.latitude} type="lat" />
                    <CoordinateRow label="Longitude" value={coords.longitude} type="lng" />
                    
                    <button 
                      type="button"
                      onClick={() => { triggerHaptic(); setIsMapDrawerOpen(true); }}
                      className="w-full mt-2 py-3 rounded-xl bg-green-500/10 hover:bg-green-500/20 text-green-500 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
                    >
                      <MapPin className="w-3 h-3" /> View Map
                    </button>
                 </div>

                 {/* Stats Grid */}
                 <div className="grid grid-cols-3 gap-3">
                    <StatCard icon={Mountain} label="Alt" value={convertAltitude(coords.altitude, units)} unit={units === 'metric' ? 'm' : 'ft'} />
                    <StatCard icon={Activity} label="Spd" value={convertSpeed(coords.speed, units)} unit={units === 'metric' ? 'km/h' : 'mph'} />
                    <StatCard icon={Navigation} label="Acc" value={coords.accuracy ? `±${Math.round(coords.accuracy)}` : '--'} unit="m" />
                 </div>

                 {/* NEW: Solar Intel Card */}
                 {weather && weather.sunrise && (
                    <SolarCard sunrise={weather.sunrise} sunset={weather.sunset} />
                 )}

                 {/* Weather Pill */}
                 {weather && (
                   <div className="flex items-center justify-between p-4 rounded-2xl bg-gradient-to-r from-blue-500/10 to-transparent border border-blue-500/10">
                      <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-blue-500/20 text-blue-400">
                            <WeatherIcon className="w-4 h-4" />
                          </div>
                          <div className="flex flex-col">
                             <span className="text-lg font-bold tabular-nums leading-none">{convertTemp(weather.temp, units)}</span>
                             <div className="flex items-center gap-2 mt-1">
                               <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wide">{weather.description}</span>
                               <span className="text-[9px] text-muted-foreground/50">•</span>
                               <div className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground">
                                  <Wind className="w-3 h-3" />
                                  {convertSpeed(weather.windSpeed / 3.6, units)}
                               </div>
                             </div>
                          </div>
                      </div>
                      <div className="text-right">
                         <span className="text-[9px] uppercase font-bold text-muted-foreground block">{address ? address.split(',')[0] : "Local"}</span>
                      </div>
                   </div>
                 )}
             </div>

             {/* Center Column: Visuals */}
             <div className="lg:col-span-8 flex flex-col md:flex-row items-center justify-center gap-12 order-1 md:order-2 p-0">
                 <CompassDisplay 
                    heading={heading} 
                    trueHeading={trueHeading} 
                    onClick={requestAccess} 
                    hasError={!!compassError} 
                    permissionGranted={permissionGranted} 
                 />
                 
                 <div className="h-px w-32 md:w-px md:h-32 bg-white/10" />

                 <div className="flex flex-col items-center gap-6">
                    <RadarMapbox 
                      path={path} 
                      lat={coords.latitude} 
                      lng={coords.longitude} 
                      heading={heading || 0}
                      mode={mapMode}
                      onRecenter={recenterMap}
                      onToggleMode={toggleMapMode}
                    />
                    {path.length > 1 && (
                      <button 
                        onClick={() => { triggerHaptic(); resetRadar(); }} 
                        className="text-[9px] text-muted-foreground hover:text-red-400 uppercase tracking-widest font-bold flex items-center gap-2 transition-colors py-2 px-4 rounded-full hover:bg-white/5"
                      >
                        <Trash2 className="w-3 h-3" /> Clear Trail
                      </button>
                    )}
                 </div>
             </div>

          </div>
        )}
      </div>

      {coords && (
        <FullMapDrawer 
          isOpen={isMapDrawerOpen} 
          onClose={() => setIsMapDrawerOpen(false)} 
          lat={coords.latitude} 
          lng={coords.longitude} 
        />
      )}
    </main>
  );
}