"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, Loader2,
  Trash2, Crosshair, Compass as CompassIcon, WifiOff,
  Maximize2, X, LocateFixed, Circle, Download, Sunrise, Sunset, Moon, Wind,
  Share2, Signal, Plus, Minus, Copy, Check
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- Mapbox GL JS ---
// Note: Ensure mapbox-gl is installed: `npm install mapbox-gl`
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// --- Configuration ---
// REPLACE THIS WITH YOUR OWN TOKEN FOR PRODUCTION
const MAPBOX_TOKEN = "pk.eyJ1Ijoib3BlbnN0cmVldGNhbSIsImEiOiJja252Ymh4ZnIwNHdkMnd0ZzF5NDVmdnR5In0.dYxz3TzZPTPzd_ibMeGK2g";
mapboxgl.accessToken = MAPBOX_TOKEN;

// Settings
const RADAR_ZOOM = 18; // Zoom level for the radar view
const TRAIL_MAX_POINTS = 100; // Visual trail length
const TRAIL_MIN_DISTANCE = 5; // Meters between trail points
const MAP_UPDATE_THRESHOLD = 80; // Meters before reloading radar background
const API_FETCH_DISTANCE_THRESHOLD = 2.0; // Kilometers before refreshing weather/address
const REC_MIN_DISTANCE = 5; // Meters between recorded GPX points
const GPS_HEADING_THRESHOLD = 1.0; // Speed (m/s) required to switch to GPS heading

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

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const triggerHaptic = () => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(10);
  }
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

// Optimized projection for local radar
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
  useEffect(() => {
    let wakeLock: any = null;
    const requestLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        // Feature not available or denied
      }
    };
    
    requestLock();
    
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestLock();
      } else if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
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
      // Performance: Throttle updates to ~5fps (200ms) to save battery and reduce React render thrashing
      if (now - lastUpdate.current < 200) return;
      if (isNaN(coords.latitude) || isNaN(coords.longitude)) return;
      
      lastUpdate.current = now;

      setState(prev => {
        // Diff check to prevent re-render if data hasn't effectively changed
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.heading === coords.heading &&
            prev.coords.speed === coords.speed) {
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
        case error.TIMEOUT: return; // Don't wipe state on timeout, just wait
      }
      setState(s => ({ ...s, loading: false, error: errorMessage }));
    };

    const watcher = navigator.geolocation.watchPosition(
      handleSuccess, handleError, 
      { 
        enableHighAccuracy: true, 
        timeout: 20000, 
        maximumAge: 0 
      }
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
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);
  
  // Animation Loop for Smooth Compass
  useEffect(() => {
    if (!permissionGranted) return;
    
    let isRunning = true;
    const loop = () => {
      if (!isRunning || !isMounted.current) return;
      const diff = targetRef.current - currentRef.current;
      
      // Performance: Stop animating if difference is negligible to save battery
      if (Math.abs(diff) < 0.05) {
         if (currentRef.current !== targetRef.current) {
            currentRef.current = targetRef.current;
            setVisualHeading((currentRef.current % 360 + 360) % 360);
         }
         // Poll slower when static
         setTimeout(() => { if (isRunning) rafIdRef.current = requestAnimationFrame(loop); }, 100);
         return;
      }
      
      // Lerp for smoothness
      currentRef.current += diff * 0.15;
      setVisualHeading((currentRef.current % 360 + 360) % 360);
      rafIdRef.current = requestAnimationFrame(loop);
    };

    rafIdRef.current = requestAnimationFrame(loop);
    return () => { 
      isRunning = false;
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); 
    };
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
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        degree = e.webkitCompassHeading;
      } else if (e.alpha !== null) {
        degree = Math.abs(360 - e.alpha);
      }

      if (degree !== null) {
        const normalized = ((degree) + 360) % 360;
        setTrueHeading(normalized);
        const current = targetRef.current;
        const currentMod = (current % 360 + 360) % 360;
        
        // Calculate shortest path rotation
        let delta = normalized - currentMod;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        targetRef.current = current + delta;
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
  accuracy,
  onRecenter,
  onToggleMode
}: { 
  path: GeoPoint[], 
  heading: number, 
  lat: number, 
  lng: number,
  mode: MapMode,
  accuracy: number | null,
  onRecenter: () => void,
  onToggleMode: () => void
}) => {
  const [anchor, setAnchor] = useState({ lat, lng });
  const [isOffCenter, setIsOffCenter] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);

  // Update anchor only when moved significantly to prevent constant image reloading
  useEffect(() => {
    const distance = getDistance(anchor.lat, anchor.lng, lat, lng);
    setIsOffCenter(distance > 30); 

    if (distance > MAP_UPDATE_THRESHOLD) {
      setAnchor({ lat, lng });
      setImgLoaded(false); 
      setMapError(false);
    }
  }, [lat, lng, anchor]);

  const currentMapUrl = useMemo(() => 
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${anchor.lng},${anchor.lat},${RADAR_ZOOM},0,0/600x600@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, 
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
  
  // Dynamic accuracy circle color
  const accColor = !accuracy ? 'border-muted/20' 
    : accuracy < 10 ? 'border-green-500/50' 
    : accuracy < 30 ? 'border-yellow-500/50' 
    : 'border-red-500/50';

  return (
    <div className="relative w-64 h-64 md:w-80 md:h-80 shrink-0 transition-all duration-300">
      <div className="absolute inset-0 rounded-full border border-border/20 bg-background/50 backdrop-blur-3xl shadow-2xl z-0" />
      <div className="w-full h-full relative isolate">
        
        {/* Map Container - Rotates based on mode */}
        <div 
          className="absolute inset-0 rounded-full overflow-hidden bg-black z-0"
          style={{ maskImage: 'radial-gradient(white, black)', transform: 'translateZ(0)' }}
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
                   src={currentMapUrl}
                   alt="Satellite View"
                   onLoad={() => setImgLoaded(true)}
                   onError={() => setMapError(true)}
                   className={`w-full h-full object-contain transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                   style={{ filter: 'grayscale(0.3) contrast(1.1) brightness(0.8)' }}
                 />
               )}
            </div>
            
            {/* SVG Overlay for Trail & Marker */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] pointer-events-none z-10">
              <svg viewBox="-200 -200 400 400" className="w-full h-full overflow-visible">
                {svgPath && (
                  <path d={svgPath} fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                )}
                <g transform={`translate(${userX}, ${userY})`}>
                   <g transform={`rotate(${markerRotation})`}>
                      <path d="M -6 -6 L 0 -18 L 6 -6" fill="rgba(34,197,94,0.9)" />
                      <circle r="5" fill="#22c55e" className="animate-pulse" />
                      <circle r="8" fill="none" stroke="#ffffff" strokeWidth="2" className="opacity-90" />
                   </g>
                </g>
              </svg>
            </div>
          </div>
        </div>

        {/* HUD Elements */}
        <div className={`absolute inset-0 rounded-full border-4 ${accColor} pointer-events-none z-10 transition-colors duration-500`} />
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
                {permissionGranted || source === 'GPS' ? `${displayHeading}°` : "--"}
             </span>
             <span className="text-[10px] font-bold text-muted-foreground tracking-[0.3em] uppercase">
                {permissionGranted || source === 'GPS' ? directionStr : "---"}
             </span>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20">
             <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${source === 'GPS' ? 'text-green-500 border-green-500/20 bg-green-500/10' : 'text-blue-500 border-blue-500/20 bg-blue-500/10'}`}>
               {source}
             </span>
        </div>
        
        {!permissionGranted && !hasError && source === 'MAG' && (
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
    <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-500/10 to-blue-900/10 border border-white/5 backdrop-blur-sm w-full shadow-sm space-y-3">
      <div className="flex items-center justify-between opacity-80">
         <div className="flex items-center gap-2">
            {isDay ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-blue-300" />}
            <span className="text-[10px] uppercase font-bold tracking-widest">{isDay ? "Daylight" : "Night Ops"}</span>
         </div>
         <span className="text-[10px] font-mono opacity-60">
           {formatTime(new Date(nextEventTime).toISOString())} {nextEventLabel === "Sunset" ? "SET" : "RISE"}
         </span>
      </div>
      <div className="relative w-full h-2 bg-black/40 rounded-full overflow-hidden">
         <div className={`absolute inset-0 opacity-20 ${isDay ? 'bg-gradient-to-r from-amber-900 via-amber-500 to-amber-900' : 'bg-gradient-to-r from-blue-900 via-blue-500 to-blue-900'}`} />
         <div 
            className={`absolute top-0 bottom-0 left-0 shadow-[0_0_10px_rgba(255,255,255,0.3)] ${isDay ? 'bg-amber-500' : 'bg-blue-500'}`} 
            style={{ width: `${progress}%`, transition: 'width 1s linear' }}
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

// --- FULL MAP DRAWER (Now using Mapbox GL JS) ---
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
  const [copied, setCopied] = useState(false);
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const marker = useRef<mapboxgl.Marker | null>(null);
  const [zoomLevel, setZoomLevel] = useState(16);

  // Initialize Map
  useEffect(() => {
    if (!isOpen || !mapContainer.current) return;
    if (map.current) return; // Initialize only once

    try {
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/satellite-streets-v12',
        center: [lng, lat],
        zoom: 16,
        attributionControl: false
      });

      map.current.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

      // Custom CSS Marker
      const el = document.createElement('div');
      el.className = 'marker';
      el.innerHTML = `
        <div style="position: relative; width: 20px; height: 20px; display: flex; justify-content: center; align-items: center;">
          <div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; background-color: rgba(34, 197, 94, 0.5); animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
          <div style="width: 10px; height: 10px; background-color: #22c55e; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px rgba(34,197,94,0.8);"></div>
        </div>
        <style>
          @keyframes ping {
            75%, 100% { transform: scale(2); opacity: 0; }
          }
        </style>
      `;

      marker.current = new mapboxgl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(map.current);

      map.current.on('zoom', () => {
        if(map.current) setZoomLevel(map.current.getZoom());
      });
    } catch (e) {
      console.error("Map initialization failed", e);
    }
  }, [isOpen]);

  // Clean up Map on unmount to prevent WebGL memory leaks
  useEffect(() => {
    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Handle Updates
  useEffect(() => {
    if (!map.current) return;
    
    // Update marker position
    if (marker.current) marker.current.setLngLat([lng, lat]);

    // Only FlyTo if we moved significantly
    const currentCenter = map.current.getCenter();
    const dist = getDistance(currentCenter.lat, currentCenter.lng, lat, lng);
    
    if (dist > 100) {
       map.current.flyTo({ center: [lng, lat], speed: 0.8 });
    }
  }, [lat, lng]);

  // Handle Resize when Drawer opens
  useEffect(() => {
    if (isOpen && map.current) {
      setTimeout(() => {
        map.current?.resize();
        map.current?.flyTo({ center: [lng, lat] });
      }, 300); // Wait for CSS transition
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
  const resetView = () => { 
    triggerHaptic(); 
    map.current?.flyTo({ center: [lng, lat], zoom: 16, bearing: 0, pitch: 0 }); 
  };

  return (
    <>
      <div className={`fixed inset-0 bg-black/90 backdrop-blur-sm z-[60] transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      
      <div className={`fixed bottom-0 left-0 right-0 h-[92dvh] bg-[#0c0c0c] border-t border-white/10 rounded-t-[2rem] shadow-2xl z-[61] transition-transform duration-500 cubic-bezier(0.32, 0.72, 0, 1) flex flex-col ${isOpen ? 'translate-y-0' : 'translate-y-full'}`}>
        
        {/* --- Header --- */}
        <div className="absolute top-0 left-0 right-0 z-[65] p-6 pt-8 flex justify-between items-start pointer-events-none bg-gradient-to-b from-black/80 to-transparent">
            <div className="pointer-events-auto space-y-1">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_#22c55e]" />
                    <h3 className="text-xl font-black text-white tracking-widest uppercase font-mono">Sat<span className="text-white/40">.Link</span></h3>
                </div>
                <button 
                  onClick={handleCopy}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 active:scale-95 transition-all group"
                >
                    <span className={`text-[10px] font-mono tracking-wider ${copied ? 'text-green-400' : 'text-white/60 group-hover:text-white'}`}>
                        {lat.toFixed(6)}, {lng.toFixed(6)}
                    </span>
                    {copied ? <Check className="w-3 h-3 text-green-400"/> : <Copy className="w-3 h-3 text-white/40 group-hover:text-white"/>}
                </button>
            </div>
            
            <button onClick={onClose} className="pointer-events-auto p-3 rounded-full bg-white/5 border border-white/10 text-white hover:bg-white/10 active:scale-90 transition-all backdrop-blur-md">
                <X className="w-5 h-5" />
            </button>
        </div>

        {/* --- Map Container --- */}
        <div 
           className="relative flex-1 w-full h-full overflow-hidden bg-[#111]"
           ref={mapContainer}
        >
           {/* Fallback Loader if map renders slowly */}
           <div className="absolute inset-0 flex items-center justify-center -z-10">
               <Loader2 className="w-8 h-8 animate-spin text-green-500/50" />
           </div>

           {/* Static HUD Overlay (Reticle) */}
           <div className="absolute inset-0 pointer-events-none z-10 opacity-[0.05]" 
                style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }} 
           />
        </div>

        {/* --- Side Controls --- */}
        <div className="absolute right-4 top-1/2 -translate-y-1/2 z-[65] flex flex-col gap-4 pointer-events-none">
             <div className="pointer-events-auto flex flex-col gap-2 bg-black/40 backdrop-blur-md p-1.5 rounded-2xl border border-white/10">
                 <button onClick={zoomIn} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors"><Plus className="w-5 h-5"/></button>
                 <button onClick={resetView} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors text-[10px] font-bold font-mono">{Math.round(zoomLevel)}z</button>
                 <button onClick={zoomOut} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/20 text-white transition-colors"><Minus className="w-5 h-5"/></button>
             </div>
        </div>

        {/* --- Bottom Drawer Actions --- */}
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
  const { heading, trueHeading, requestAccess, permissionGranted, error: compassError } = useCompass();
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
  
  const isMountedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => { 
    isMountedRef.current = true;
    setMounted(true); 
    return () => { isMountedRef.current = false; };
  }, []);

  const isMoving = (coords?.speed ?? 0) > GPS_HEADING_THRESHOLD;
  const effectiveHeading = isMoving && coords?.heading !== null && coords?.heading !== undefined
    ? coords.heading
    : (heading ?? 0);
  
  const effectiveTrueHeading = isMoving && coords?.heading !== null && coords?.heading !== undefined
    ? coords.heading
    : trueHeading;

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
  if (!mounted) return null;

  return (
    <main className="relative flex flex-col items-center min-h-[100dvh] w-full bg-[#09090b] text-foreground p-4 md:p-8 overflow-x-hidden touch-manipulation font-sans selection:bg-green-500/30 pb-32">
      <div className="absolute inset-0 pointer-events-none z-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.05),transparent_70%)]" />
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '50px 50px' }} />
      </div>

      {/* Header */}
      <div className="w-full max-w-5xl flex justify-between items-start z-40 mb-6 shrink-0">
         <div className="flex flex-col">
             <h1 className="text-xs font-black tracking-[0.3em] text-muted-foreground/60 uppercase">Field Navigation</h1>
             <div className="flex items-center gap-2 mt-1">
                 <div className={`w-2 h-2 rounded-full ${coords ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
                 <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{coords ? "Live Data" : "Offline"}</span>
             </div>
         </div>

         <div className="flex gap-2">
            <button
               onClick={toggleRecording}
               className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${
                 isRecording ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-white/5 border-white/5 text-muted-foreground hover:bg-white/10"
               }`}
            >
               {isRecording ? <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> : <Circle className="w-2 h-2" />}
               {isRecording ? "REC" : "LOG"}
            </button>
            <button onClick={toggleUnits} className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all active:scale-95">
               {units === 'metric' ? 'MET' : 'IMP'}
            </button>
         </div>
      </div>

      <div className="w-full max-w-5xl flex flex-col items-center justify-start space-y-6 z-10">
        {loading && !coords && (
          <div className="flex flex-col items-center justify-center h-64 space-y-6 animate-pulse">
            <Loader2 className="w-8 h-8 animate-spin text-green-500/50" />
            <span className="text-xs tracking-[0.3em] uppercase text-green-500/70 font-bold">Acquiring GPS Signal...</span>
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
             <button onClick={downloadGPX} className="w-full py-4 rounded-xl bg-green-500 text-black font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(34,197,94,0.4)] flex items-center justify-center gap-2 active:scale-95 transition-transform">
                <Download className="w-5 h-5" /> Download Mission Log
             </button>
          </div>
        )}

        {coords && (
          <div className="w-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
             
             {/* Left Column */}
             <div className="lg:col-span-4 flex flex-col gap-4 order-2 md:order-1">
                 <div className="bg-card/30 backdrop-blur-sm border border-white/5 rounded-3xl p-5 space-y-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Position</span>
                        <div className="flex gap-2">
                          <button onClick={handleShare} className="p-1.5 hover:bg-white/10 rounded-full text-muted-foreground hover:text-white transition-colors"><Share2 className="w-3.5 h-3.5" /></button>
                          <Signal className={`w-3.5 h-3.5 ${(coords.accuracy || 100) < 15 ? 'text-green-500' : (coords.accuracy || 100) < 50 ? 'text-yellow-500' : 'text-red-500'}`} />
                        </div>
                    </div>
                    <CoordinateRow label="Latitude" value={coords.latitude} type="lat" />
                    <CoordinateRow label="Longitude" value={coords.longitude} type="lng" />
                    <button onClick={() => { triggerHaptic(); setIsMapDrawerOpen(true); }} className="w-full mt-2 py-3 rounded-xl bg-green-500/10 hover:bg-green-500/20 text-green-500 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors active:scale-[0.98]">
                      <MapPin className="w-3 h-3" /> Satellite Map
                    </button>
                 </div>

                 <div className="grid grid-cols-3 gap-3">
                    <StatCard icon={Mountain} label="Alt" value={convertAltitude(coords.altitude, units)} unit={units === 'metric' ? 'm' : 'ft'} />
                    <StatCard icon={Activity} label="Spd" value={convertSpeed(coords.speed, units)} unit={units === 'metric' ? 'km/h' : 'mph'} />
                    <StatCard icon={Navigation} label="Acc" value={coords.accuracy ? `±${Math.round(coords.accuracy)}` : '--'} unit="m" />
                 </div>

                 {weather && weather.sunrise && <SolarCard sunrise={weather.sunrise} sunset={weather.sunset} />}
                 
                 {weather && (
                   <div className="flex items-center justify-between p-4 rounded-2xl bg-gradient-to-r from-blue-500/10 to-transparent border border-blue-500/10">
                      <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-blue-500/20 text-blue-400"><WeatherIcon className="w-4 h-4" /></div>
                          <div className="flex flex-col">
                             <span className="text-lg font-bold tabular-nums leading-none">{convertTemp(weather.temp, units)}</span>
                             <div className="flex items-center gap-2 mt-1">
                               <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wide">{weather.description}</span>
                               <span className="text-[9px] text-muted-foreground/50">•</span>
                               <div className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground"><Wind className="w-3 h-3" />{convertSpeed(weather.windSpeed / 3.6, units)}</div>
                             </div>
                          </div>
                      </div>
                      <div className="text-right"><span className="text-[9px] uppercase font-bold text-muted-foreground block">{address ? address.split(',')[0] : "Local"}</span></div>
                   </div>
                 )}
             </div>

             {/* Center Column: Visuals */}
             <div className="lg:col-span-8 flex flex-col md:flex-row items-center justify-center gap-12 order-1 md:order-2 p-0">
                 <CompassDisplay 
                    heading={effectiveHeading} 
                    trueHeading={effectiveTrueHeading} 
                    onClick={requestAccess} 
                    hasError={!!compassError} 
                    permissionGranted={permissionGranted}
                    source={isMoving ? 'GPS' : 'MAG'}
                 />
                 <div className="h-px w-32 md:w-px md:h-32 bg-white/10" />
                 <div className="flex flex-col items-center gap-6">
                    <RadarMapbox 
                      path={path} 
                      lat={coords.latitude} 
                      lng={coords.longitude} 
                      heading={effectiveHeading || 0}
                      mode={mapMode}
                      accuracy={coords.accuracy}
                      onRecenter={recenterMap}
                      onToggleMode={toggleMapMode}
                    />
                    {path.length > 1 && (
                      <button onClick={() => { triggerHaptic(); recenterMap(); }} className="text-[9px] text-muted-foreground hover:text-red-400 uppercase tracking-widest font-bold flex items-center gap-2 transition-colors py-2 px-4 rounded-full hover:bg-white/5">
                        <Trash2 className="w-3 h-3" /> Clear Visual Trail
                      </button>
                    )}
                 </div>
             </div>
          </div>
        )}
      </div>

      {coords && (
        <FullMapDrawer isOpen={isMapDrawerOpen} onClose={() => setIsMapDrawerOpen(false)} lat={coords.latitude} lng={coords.longitude} />
      )}
    </main>
  );
}