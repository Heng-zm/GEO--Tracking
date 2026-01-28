"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, Loader2,
  Trash2, Crosshair, Thermometer, Compass as CompassIcon, RotateCcw,
  WifiOff
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- Configuration ---
// Note: Ensure this token has Static Images API permissions.
const MAPBOX_TOKEN = "pk.eyJ1Ijoib3BlbnN0cmVldGNhbSIsImEiOiJja252Ymh4ZnIwNHdkMnd0ZzF5NDVmdnR5In0.dYxz3TzZPTPzd_ibMeGK2g";
const RADAR_ZOOM = 18;
const TRAIL_MAX_POINTS = 100;
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
};

type GeoPoint = { lat: number; lng: number; id: number; timestamp: number };

type UnitSystem = 'metric' | 'imperial';

type MapMode = 'heading-up' | 'north-up';

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(6)}°${direction}`;
};

const convertSpeed = (ms: number | null, system: UnitSystem): string => {
  if (ms === null || ms < 0) return "0.0";
  return system === 'metric' 
    ? `${(ms * 3.6).toFixed(1)} km/h` 
    : `${(ms * 2.23694).toFixed(1)} mph`;
};

const convertAltitude = (meters: number | null, system: UnitSystem): string => {
  if (meters === null) return "--";
  return system === 'metric'
    ? `${Math.round(meters)} m`
    : `${Math.round(meters * 3.28084)} ft`;
};

const convertTemp = (celsius: number, system: UnitSystem): string => {
  return system === 'metric'
    ? `${celsius.toFixed(1)}°C`
    : `${((celsius * 9/5) + 32).toFixed(1)}°F`;
};

const getWeatherInfo = (code: number) => {
  if (code === 0) return { label: "Clear", icon: Sun };
  if (code <= 3) return { label: "Cloudy", icon: CloudSun };
  if (code <= 48) return { label: "Fog", icon: CloudFog };
  if (code <= 67) return { label: "Rain", icon: CloudRain };
  if (code <= 77) return { label: "Snow", icon: Snowflake };
  if (code <= 82) return { label: "Heavy Rain", icon: CloudRain };
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
  const earthCircumference = 40075016.686;
  const metersPerPx = (earthCircumference * Math.cos(anchorLat * Math.PI / 180)) / Math.pow(2, zoom + 8);
  const dLat = (lat - anchorLat) * 111319.9; 
  const dLng = (lng - anchorLng) * 111319.9 * Math.cos(anchorLat * Math.PI / 180);
  return { x: dLng / metersPerPx, y: -dLat / metersPerPx };
};

// --- Hooks ---
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
      if (now - lastUpdate.current < 500) return;
      lastUpdate.current = now;

      setState(prev => {
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.speed === coords.speed &&
            prev.coords.heading === coords.heading) {
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
        case error.PERMISSION_DENIED:
          errorMessage = "Location access denied";
          break;
        case error.POSITION_UNAVAILABLE:
          errorMessage = "Position unavailable";
          break;
        case error.TIMEOUT:
          // Don't clear old coords on timeout, just keep loading state false
          return; 
      }
      setState(s => ({ ...s, loading: false, error: errorMessage }));
    };

    const watcher = navigator.geolocation.watchPosition(
      handleSuccess, 
      handleError, 
      { 
        enableHighAccuracy: true, 
        timeout: 20000, 
        maximumAge: 2000 
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
  const isAnimating = useRef(false);

  // Check if permission is needed on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
      if (!isIOS) {
        setPermissionGranted(true);
      }
    }
  }, []);

  const requestAccess = useCallback(async () => {
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') { 
          setPermissionGranted(true); 
          setError(null); 
        } else { 
          setError("Permission denied"); 
        }
      } catch (e) { 
        console.error(e);
        setError("Compass not supported"); 
      }
    } else { 
      setPermissionGranted(true); 
      setError(null); 
    }
  }, []);

  // Physics Loop
  useEffect(() => {
    const loop = () => {
      if (!isAnimating.current) {
         rafIdRef.current = requestAnimationFrame(loop);
         return;
      }

      const diff = targetRef.current - currentRef.current;
      
      if (Math.abs(diff) < 0.05) {
         currentRef.current = targetRef.current;
         setVisualHeading((currentRef.current % 360 + 360) % 360);
         isAnimating.current = false;
         rafIdRef.current = requestAnimationFrame(loop);
         return;
      }

      currentRef.current += diff * 0.15;
      setVisualHeading((currentRef.current % 360 + 360) % 360);
      
      rafIdRef.current = requestAnimationFrame(loop);
    };
    
    if (permissionGranted) {
      rafIdRef.current = requestAnimationFrame(loop);
    }
    
    return () => { 
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); 
    };
  }, [permissionGranted]);

  // Event Listener
  useEffect(() => {
    if (!permissionGranted) return;
    
    const handleOrientation = (e: any) => {
      let degree: number | null = null;
      
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        degree = e.webkitCompassHeading;
      } else if (e.alpha !== null) {
        // Fallback for Android (simplified, real logic requires absolute checking)
         degree = Math.abs(360 - e.alpha);
      }
      
      if (degree !== null) {
        const normalized = ((degree) + 360) % 360;
        setTrueHeading(normalized);
        
        // Calculate shortest rotation path
        const current = targetRef.current;
        // Get current visual angle normalized 0-360 for delta calc
        const currentMod = (current % 360 + 360) % 360;
        let delta = normalized - currentMod;
        
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        
        // Only update target if change is significant to avoid micro-jitters
        if (Math.abs(delta) > 0.5) {
          targetRef.current = current + delta;
          isAnimating.current = true;
        }
      }
    };
    
    const win = window as any;
    const eventName = 'ondeviceorientationabsolute' in win ? 'deviceorientationabsolute' : 'deviceorientation';
    
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
      setMapError(false); // Retry loading on move
    }
  }, [lat, lng, anchor]);

  const mapUrl = useMemo(() => 
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${anchor.lng},${anchor.lat},${RADAR_ZOOM},0,0/500x500@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`, 
  [anchor]);

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
    <div className="relative w-64 h-64 md:w-72 md:h-72">
      <div className="w-full h-full rounded-full border-2 border-border/40 bg-black overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.6)] group relative">
        
        {/* Map Container */}
        <div 
          className="w-full h-full absolute inset-0 will-change-transform transition-transform duration-100 ease-linear"
          style={{ transform: `rotate(${-rotation}deg)` }}
        >
          {/* Map Image / Fallback Grid */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%]">
             <div className="absolute inset-0 bg-[#0c100c]" />
             
             {/* Fallback Grid */}
             {(!imgLoaded || mapError) && (
               <div className="absolute inset-0 opacity-20" 
                 style={{ 
                   backgroundImage: 'radial-gradient(circle, #22c55e 1px, transparent 1px)', 
                   backgroundSize: '30px 30px' 
                 }} 
               />
             )}

             {!mapError && (
               <img
                 src={mapUrl}
                 alt="Map"
                 onLoad={() => setImgLoaded(true)}
                 onError={() => setMapError(true)}
                 className={`w-full h-full object-contain transition-opacity duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                 style={{ filter: 'brightness(0.7) contrast(1.2) sepia(0.15)' }}
               />
             )}
          </div>

          {/* SVG Overlay */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] pointer-events-none">
            <svg viewBox="-200 -200 400 400" className="w-full h-full overflow-visible">
              {svgPath && (
                <path 
                  d={svgPath} 
                  fill="none" 
                  stroke="#22c55e" 
                  strokeWidth="3" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                  className="opacity-70 drop-shadow-[0_0_4px_rgba(34,197,94,0.5)]" 
                />
              )}
              
              <g transform={`translate(${userX}, ${userY})`}>
                 <g transform={`rotate(${markerRotation})`}>
                    <path d="M -8 -8 L 0 -24 L 8 -8" fill="rgba(34,197,94,0.3)" />
                    <circle r="6" fill="#22c55e" className="animate-pulse" />
                    <circle r="9" fill="none" stroke="#ffffff" strokeWidth="2" />
                 </g>
              </g>
            </svg>
          </div>
        </div>

        {/* Radar Sweep Animation */}
        <div className="absolute inset-0 rounded-full pointer-events-none overflow-hidden">
             <div className="absolute inset-0 bg-[conic-gradient(from_0deg,transparent_0deg,transparent_270deg,rgba(34,197,94,0.2)_360deg)] animate-[spin_4s_linear_infinite]" />
        </div>

        {/* Static Bezel */}
        <div className="absolute inset-0 pointer-events-none rounded-full border border-green-500/30 z-20">
          <div className="absolute top-1/2 left-0 w-full h-[1px] bg-green-500/15" />
          <div className="absolute top-0 left-1/2 h-full w-[1px] bg-green-500/15" />
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,transparent_55%,rgba(0,0,0,0.85)_100%)]" />
          
          <div 
            className="absolute inset-0 pointer-events-none transition-transform duration-100 ease-linear"
            style={{ transform: `rotate(${-rotation}deg)` }}
          >
            <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[9px] font-black text-red-500 drop-shadow-lg">N</div>
          </div>
        </div>
        
        {/* Attribution (Required by Mapbox) */}
        {imgLoaded && !mapError && (
          <div className="absolute bottom-1 right-3 text-[7px] text-white/40 z-20 pointer-events-none">© Mapbox</div>
        )}

        {/* Mode Toggle */}
        <button
           onClick={onToggleMode}
           type="button"
           className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-black tracking-[0.1em] text-green-500/90 bg-black/80 px-2.5 py-1 rounded-sm backdrop-blur-md z-30 border border-green-500/20 pointer-events-auto hover:bg-green-500/20 transition-all active:scale-95 touch-manipulation"
        >
          {mode === 'heading-up' ? 'H-UP' : 'N-UP'}
        </button>
      </div>

      {isOffCenter && (
        <button 
          onClick={onRecenter}
          type="button"
          className="absolute -bottom-8 left-1/2 -translate-x-1/2 p-2 rounded-full bg-background/80 backdrop-blur-sm border border-border/40 text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-all duration-200 active:scale-95 shadow-lg z-30 touch-manipulation"
        >
          <Crosshair className="w-4 h-4" />
        </button>
      )}
    </div>
  );
});
RadarMapbox.displayName = "RadarMapbox";

const CompassTicks = memo(() => (
  <>
    <circle cx="50" cy="50" r="48" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/10 fill-none" />
    {[...Array(60)].map((_, i) => {
      const isCardinal = i % 15 === 0;
      const isMajor = i % 5 === 0;  
      const length = isCardinal ? 10 : isMajor ? 7 : 4;
      const width = isCardinal ? 1.5 : isMajor ? 1 : 0.5;
      const colorClass = isCardinal ? "text-foreground" : isMajor ? "text-foreground/60" : "text-muted-foreground/30";
      return (
        <line key={i} x1="50" y1="6" x2="50" y2={6 + length} transform={`rotate(${i * 6} 50 50)`} stroke="currentColor" strokeWidth={width} className={colorClass} strokeLinecap="round" />
      );
    })}
    <text x="50" y="28" textAnchor="middle" className="text-[7px] font-black fill-red-500" transform="rotate(0 50 50)">N</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(90 50 50)">E</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(180 50 50)">S</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(270 50 50)">W</text>
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
    <div className="flex flex-col items-center justify-center mb-6 relative z-10 animate-in zoom-in-50 duration-700 fade-in">
      <div className="relative w-64 h-64 md:w-72 md:h-72 cursor-pointer group" onClick={onClick}>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="w-0 h-0 border-l-[7px] border-l-transparent border-r-[7px] border-r-transparent border-t-[12px] border-t-red-500/90 drop-shadow-lg" />
        </div>
        
        <div 
          className="w-full h-full will-change-transform transition-transform duration-100 ease-linear"
          style={{ transform: `rotate(${-rotation}deg)` }}
        >
          <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none">
            <CompassTicks />
          </svg>
        </div>
        
        {!permissionGranted && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full z-30 bg-background/5 backdrop-blur-[2px]">
            <button type="button" className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-foreground/80 animate-pulse bg-background/90 backdrop-blur-md px-6 py-3 rounded-full border border-border/40 shadow-xl hover:scale-105 transition-transform active:scale-95 touch-manipulation">
              <CompassIcon className="w-4 h-4" /> Tap to Align
            </button>
          </div>
        )}
        
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center z-30 bg-background/50 backdrop-blur-sm rounded-full">
            <WifiOff className="w-10 h-10 text-destructive/80" />
          </div>
        )}
      </div>
      
      <div className="mt-4 flex flex-col items-center">
        <div className="text-5xl md:text-6xl font-mono font-black tracking-tighter tabular-nums text-foreground select-all">
          {permissionGranted ? `${displayHeading}°` : "--°"}
        </div>
        <div className="text-sm font-bold text-muted-foreground/60 tracking-[0.5em] uppercase mt-2">
          {permissionGranted ? directionStr : "---"}
        </div>
      </div>
    </div>
  );
});
CompassDisplay.displayName = "CompassDisplay";

const CoordinateDisplay = memo(({ 
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
    if (!navigator.clipboard) return;
    try { 
      await navigator.clipboard.writeText(formattedValue); 
      setCopied(true); 
      setTimeout(() => setCopied(false), 2000); 
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };
  
  return (
    <div 
      className="group cursor-pointer flex flex-col items-center justify-center transition-all duration-200 hover:opacity-70 active:scale-95 px-4 py-2 rounded-lg hover:bg-muted/20 touch-manipulation" 
      onClick={handleCopy}
    >
      <span className={`text-[9px] uppercase tracking-[0.25em] mb-2 font-bold select-none transition-colors duration-300 ${copied ? "text-green-500" : "text-muted-foreground"}`}>
        {copied ? "COPIED" : label}
      </span>
      <span className={`text-2xl md:text-4xl lg:text-5xl font-black tracking-tighter font-mono tabular-nums transition-colors duration-300 select-all whitespace-nowrap ${copied ? "text-green-500" : "text-foreground"}`}>
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

const StatMinimal = ({ icon: Icon, label, value }: { icon: any, label: string, value: string }) => (
  <div className="flex flex-col items-center justify-center min-w-[80px] p-3 rounded-lg hover:bg-muted/30 transition-colors">
    <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
      <Icon className="w-3.5 h-3.5 opacity-60" />
      <span className="text-[9px] uppercase tracking-widest font-bold opacity-80">{label}</span>
    </div>
    <span className="text-lg md:text-xl font-mono font-bold text-foreground/90 tabular-nums whitespace-nowrap">{value}</span>
  </div>
);

export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { heading, trueHeading, requestAccess, permissionGranted, error: compassError } = useCompass();
  const [address, setAddress] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [isCtxLoading, setIsCtxLoading] = useState(false);
  const [path, setPath] = useState<GeoPoint[]>([]);
  const [units, setUnits] = useState<UnitSystem>('metric');
  const [mapMode, setMapMode] = useState<MapMode>('heading-up');
  const [lastApiFetch, setLastApiFetch] = useState<{lat: number, lng: number} | null>(null);
  const [mounted, setMounted] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!coords) return;
    
    setPath(prev => {
      const newPoint = { 
        lat: coords.latitude, 
        lng: coords.longitude, 
        id: Date.now(),
        timestamp: Date.now()
      };
      
      if (prev.length === 0) return [newPoint];
      
      const last = prev[prev.length - 1];
      const distance = getDistance(last.lat, last.lng, coords.latitude, coords.longitude);
      
      if (distance > TRAIL_MIN_DISTANCE) {
        const newPath = [...prev, newPoint];
        return newPath.length > TRAIL_MAX_POINTS 
          ? newPath.slice(newPath.length - TRAIL_MAX_POINTS) 
          : newPath;
      }
      return prev;
    });
  }, [coords]);

  const resetRadar = useCallback(() => { 
    if (coords) {
      setPath([{ 
        lat: coords.latitude, 
        lng: coords.longitude, 
        id: Date.now(),
        timestamp: Date.now()
      }]); 
    }
  }, [coords]);

  const recenterMap = useCallback(() => resetRadar(), [resetRadar]);
  const toggleUnits = useCallback(() => setUnits(prev => prev === 'metric' ? 'imperial' : 'metric'), []);
  const toggleMapMode = useCallback(() => setMapMode(prev => prev === 'heading-up' ? 'north-up' : 'heading-up'), []);

  const debouncedCoords = useDebounce(coords, 2000);

  useEffect(() => {
    if (!debouncedCoords) return;
    
    if (lastApiFetch) {
        const distKm = getDistance(lastApiFetch.lat, lastApiFetch.lng, debouncedCoords.latitude, debouncedCoords.longitude) / 1000;
        if (distKm < API_FETCH_DISTANCE_THRESHOLD && address && weather) return;
    }

    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    
    const fetchData = async () => {
      setIsCtxLoading(true);
      try {
        const { latitude, longitude } = debouncedCoords;
        const signal = abortControllerRef.current?.signal;
        
        const [geoRes, weatherRes] = await Promise.allSettled([
          fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14`, 
            { signal }
          ),
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`, 
            { signal }
          )
        ]);
        
        if (signal?.aborted) return;

        if (geoRes.status === 'fulfilled' && geoRes.value.ok) {
          try {
            const data = await geoRes.value.json();
            const addr = data.address;
            if (addr) {
              const location = [
                addr.city, addr.town, addr.village, addr.hamlet, addr.suburb, addr.county
              ].find(v => v && v.length > 0) || "Unknown Location";
              setAddress(addr.country_code ? `${location}, ${addr.country_code.toUpperCase()}` : location);
            }
          } catch (e) { console.warn("Geo parse error", e); }
        }
        
        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
          try {
            const data = await weatherRes.value.json();
            const info = getWeatherInfo(data.current.weather_code);
            setWeather({ 
              temp: data.current.temperature_2m, 
              code: data.current.weather_code, 
              description: info.label 
            });
          } catch (e) { console.warn("Weather parse error", e); }
        }
        
        setLastApiFetch({ lat: latitude, lng: longitude });

      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error('Fetch error:', err);
        }
      } finally { 
        if (abortControllerRef.current?.signal.aborted === false) {
             setIsCtxLoading(false); 
        }
      }
    };
    
    fetchData();
    return () => { if (abortControllerRef.current) abortControllerRef.current.abort(); };
  }, [debouncedCoords, lastApiFetch, address, weather]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;

  if (!mounted) return null;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4 overflow-hidden select-none touch-manipulation">
      <div className="absolute top-4 right-4 z-50 flex gap-2">
        <button 
          onClick={toggleUnits} 
          type="button"
          className="p-2 rounded-full bg-muted/20 hover:bg-muted/40 backdrop-blur-md text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors border border-border/10 touch-manipulation"
        >
          {units === 'metric' ? 'MET' : 'IMP'}
        </button>
      </div>

      <div className="w-full max-w-7xl flex flex-col items-center justify-start space-y-8 pb-12 mt-10 md:mt-0">
        <CompassDisplay 
          heading={heading} 
          trueHeading={trueHeading} 
          onClick={requestAccess} 
          hasError={!!compassError} 
          permissionGranted={permissionGranted} 
        />
        
        {loading && !coords && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col items-center space-y-4 pt-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/60" />
            <span className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground font-medium">Acquiring Satellites</span>
          </div>
        )}
        
        {error && !coords && (
          <Alert variant="destructive" className="max-w-md bg-transparent border border-destructive/30 backdrop-blur-sm">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle className="text-sm font-bold uppercase tracking-wide">Location Error</AlertTitle>
            <AlertDescription className="text-xs opacity-90">{error}</AlertDescription>
          </Alert>
        )}
        
        {coords && (
          <div className="w-full flex flex-col items-center gap-8 animate-in slide-in-from-bottom-4 fade-in duration-700">
            <div className="relative flex flex-col items-center gap-4">
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
                  onClick={resetRadar} 
                  type="button"
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-destructive transition-colors px-3 py-1.5 rounded-full hover:bg-destructive/10 active:scale-95 touch-manipulation"
                >
                  <Trash2 className="w-3 h-3" />
                  <span className="uppercase tracking-wider font-medium">Clear Trail</span>
                </button>
              )}
            </div>
            
            <div className="flex flex-col lg:flex-row gap-6 lg:gap-20 items-center justify-center text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden lg:block h-16 w-px bg-border/30" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>
            
            <div className="flex flex-wrap justify-center gap-4 md:gap-12 border-t border-border/20 pt-6 w-full max-w-3xl">
              <StatMinimal icon={Mountain} label="Alt" value={convertAltitude(coords.altitude, units)} />
              <StatMinimal icon={Activity} label="Spd" value={convertSpeed(coords.speed, units)} />
              <StatMinimal icon={Navigation} label="Acc" value={coords.accuracy ? `±${Math.round(coords.accuracy)} m` : '-- m'} />
            </div>
            
            <div className="w-full flex flex-col items-center gap-3 mt-2">
              <button 
                type="button"
                onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`, '_blank', 'noopener,noreferrer')} 
                className="group flex items-center gap-3 text-muted-foreground hover:text-foreground transition-all duration-300 px-5 py-2.5 rounded-full hover:bg-muted/30 active:scale-95 touch-manipulation"
              >
                <MapPin className="w-4 h-4 text-red-500/80 group-hover:scale-110 transition-transform" />
                {(!address && isCtxLoading) ? (
                  <div className="h-4 w-40 bg-muted-foreground/10 animate-pulse rounded" />
                ) : (
                  <span className="text-base md:text-lg font-light tracking-wide text-center">{address || "Locating..."}</span>
                )}
              </button>
              
              {weather && (
                <div className="flex items-center gap-3 text-muted-foreground/80 px-5 py-2 rounded-full bg-muted/10 backdrop-blur-sm border border-border/20">
                  <WeatherIcon className="w-4 h-4" />
                  <span className="text-sm font-medium text-foreground tabular-nums">{convertTemp(weather.temp, units)}</span>
                  <span className="w-px h-3 bg-border/60" />
                  <span className="text-[10px] uppercase tracking-wider font-bold">{weather.description}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}