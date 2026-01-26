"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudFog, CloudSun,
  AlertCircle, Mountain, Activity, Navigation, MapPin, RefreshCcw, Loader2
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  // 7 decimals = ~11mm precision (Detects small movements)
  return `${Math.abs(value).toFixed(7)}°${direction}`;
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

// --- Custom Hooks ---

const useGeolocation = () => {
  const [state, setState] = useState<GeoState>({ coords: null, error: null, loading: true });

  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setState(s => ({ ...s, loading: false, error: "Not supported" }));
      return;
    }

    const handleSuccess = ({ coords }: GeolocationPosition) => {
      setState(prev => {
        // High-frequency update filter: Only update React state if data actually changed
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.speed === coords.speed &&
            prev.coords.heading === coords.heading &&
            prev.coords.altitude === coords.altitude) {
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
      let message = "Unknown error";
      switch (error.code) {
        case error.PERMISSION_DENIED: message = "GPS Denied"; break;
        case error.POSITION_UNAVAILABLE: message = "Signal Lost"; break;
        case error.TIMEOUT: message = "Timeout"; break;
      }
      setState(s => ({ ...s, loading: false, error: message }));
    };

    // Aggressive options for realtime tracking
    const options: PositionOptions = { 
      enableHighAccuracy: true, 
      timeout: 5000, 
      maximumAge: 0 // Do not use cached positions, force hardware ping
    };
    
    const watcher = navigator.geolocation.watchPosition(handleSuccess, handleError, options);
    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  return state;
};

const useCompass = () => {
  const [visualHeading, setVisualHeading] = useState<number | null>(null);
  const [trueHeading, setTrueHeading] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Physics engine refs
  const targetRef = useRef<number>(0);
  const currentRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  const requestAccess = useCallback(async () => {
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') {
          setPermissionGranted(true);
          setError(null);
        } else {
          setError("Compass Denied");
        }
      } catch (e) {
        setError("Not Supported");
      }
    } else {
      setPermissionGranted(true);
      setError(null);
    }
  }, []);

  // Animation Loop (60Hz+)
  useEffect(() => {
    if (!permissionGranted) return;

    const loop = () => {
      // Pause if tab is hidden to save battery
      if (document.hidden) {
        rafIdRef.current = requestAnimationFrame(loop);
        return; 
      }

      // Physics Interpolation (Lerp)
      // 0.4 factor = Very fast response (Realtime feel)
      const smoothness = 0.4; 
      const diff = targetRef.current - currentRef.current;
      
      // Update even on micro-movements (0.01 degree)
      if (Math.abs(diff) > 0.01) {
        currentRef.current += diff * smoothness;
        setVisualHeading(currentRef.current);
      }
      
      rafIdRef.current = requestAnimationFrame(loop);
    };
    
    loop();
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [permissionGranted]);

  // Sensor Listener
  useEffect(() => {
    if (!permissionGranted) return;

    const handleOrientation = (e: any) => {
      let degree: number | null = null;
      
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        degree = e.webkitCompassHeading; // iOS
      } else if (e.alpha !== null) {
        degree = 360 - e.alpha; // Android
      }

      if (degree !== null) {
        setTrueHeading((degree + 360) % 360);

        // Calculate shortest rotation path (avoid 360->0 spin)
        const current = targetRef.current;
        const currentMod = (current % 360 + 360) % 360;
        let delta = degree - currentMod;
        
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
          <line 
            key={i} x1="50" y1="6" x2="50" y2={6 + length} 
            transform={`rotate(${i * 6} 50 50)`} 
            stroke="currentColor" strokeWidth={width} className={colorClass} strokeLinecap="round"
          />
       )
    })}
    <text x="50" y="28" textAnchor="middle" className="text-[7px] font-black fill-red-500" transform="rotate(0 50 50)">N</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(90 50 50)">E</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(180 50 50)">S</text>
    <text x="50" y="28" textAnchor="middle" className="text-[6px] font-bold fill-foreground" transform="rotate(270 50 50)">W</text>
    <circle cx="50" cy="50" r="1.5" className="fill-foreground/20" />
    <line x1="40" y1="50" x2="60" y2="50" stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/30" />
    <line x1="50" y1="40" x2="50" y2="60" stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/30" />
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
  const rotation = heading ? -heading : 0;
  const directionStr = trueHeading ? getCompassDirection(trueHeading) : "--";
  const displayHeading = trueHeading ? Math.round(trueHeading) : 0;

  return (
    <div className="flex flex-col items-center justify-center mb-4 relative z-10 animate-in zoom-in-50 duration-700 fade-in">
      <div 
        className="relative w-72 h-72 md:w-80 md:h-80 cursor-pointer group tap-highlight-transparent"
        onClick={onClick}
      >
         {/* Red Pointer */}
         <div className="absolute top-0 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
             <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[10px] border-t-red-500/80 drop-shadow-lg filter blur-[0.2px]" />
         </div>
         
         {/* Rotating Dial */}
         <div 
            className="w-full h-full will-change-transform"
            style={{ transform: `rotate(${rotation}deg)` }}
         >
           <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none">
              <CompassTicks />
           </svg>
         </div>

         {/* Permission Button */}
         {!permissionGranted && !hasError && (
             <div className="absolute inset-0 flex items-center justify-center rounded-full z-30 bg-background/5 backdrop-blur-[1px]">
                <button className="text-[10px] font-bold uppercase tracking-[0.2em] text-foreground/80 animate-pulse bg-background/80 backdrop-blur-md px-6 py-3 rounded-full border border-border/40 shadow-xl hover:scale-105 transition-transform active:scale-95">
                   Tap to Align
                </button>
             </div>
         )}
         
         {/* Error State */}
         {hasError && (
            <div className="absolute inset-0 flex items-center justify-center z-30 bg-background/50 backdrop-blur-sm rounded-full">
                <AlertCircle className="w-10 h-10 text-destructive/80" />
            </div>
         )}
      </div>

      {/* Heading Text */}
      <div className="mt-4 flex flex-col items-center">
        <div className="text-6xl font-mono font-black tracking-tighter tabular-nums text-foreground select-all">
          {permissionGranted ? displayHeading : "--"}°
        </div>
        <div className="text-sm font-bold text-muted-foreground/60 tracking-[0.5em] uppercase mt-2">
          {permissionGranted ? directionStr : "---"}
        </div>
      </div>
    </div>
  );
});
CompassDisplay.displayName = "CompassDisplay";

const CoordinateDisplay = memo(({ label, value, type }: { label: string; value: number; type: 'lat' | 'lng' }) => {
  const formattedValue = useMemo(() => formatCoordinate(value, type), [value, type]);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!navigator.clipboard) return;
    try { 
      await navigator.clipboard.writeText(formattedValue); 
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {}
  };

  return (
    <div 
      className="group cursor-pointer flex flex-col items-center justify-center transition-all duration-200 hover:opacity-70 active:scale-95"
      onClick={handleCopy}
    >
      <span className={`text-[9px] uppercase tracking-[0.25em] mb-2 font-bold select-none transition-colors duration-300 ${copied ? "text-green-500" : "text-muted-foreground"}`}>
        {copied ? "COPIED" : label}
      </span>
      <span 
        className={`text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter font-mono tabular-nums transition-colors duration-300 select-all whitespace-nowrap ${copied ? "text-green-500" : "text-foreground"}`}
      >
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

const StatMinimal = ({ icon: Icon, label, value }: { icon: any, label: string, value: string }) => (
    <div className="flex flex-col items-center justify-center min-w-[80px] p-2 rounded-lg hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
            <Icon className="w-3 h-3 opacity-60" />
            <span className="text-[9px] uppercase tracking-widest font-bold opacity-80">{label}</span>
        </div>
        <span className="text-lg font-mono font-bold text-foreground/90 tabular-nums">
            {value}
        </span>
    </div>
);

export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { heading, trueHeading, requestAccess, permissionGranted, error: compassError } = useCompass();
  const [address, setAddress] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [isCtxLoading, setIsCtxLoading] = useState(false);
  
  // API Calls MUST be debounced to prevent rate limits/bans (3 seconds)
  // This does NOT affect the coordinate display, which is realtime.
  const debouncedCoords = useDebounce(coords, 3000);

  useEffect(() => {
    if (!debouncedCoords) return;
    const controller = new AbortController();
    setIsCtxLoading(true);

    const fetchData = async () => {
      try {
        const { latitude, longitude } = debouncedCoords;
        const [geoRes, weatherRes] = await Promise.allSettled([
          fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14`, { signal: controller.signal }),
          fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`, { signal: controller.signal })
        ]);

        if (geoRes.status === 'fulfilled' && geoRes.value.ok) {
          const data = await geoRes.value.json();
          const addr = data.address;
          if (addr) {
            const locationStr = [addr.city, addr.town, addr.village, addr.hamlet, addr.county].find(val => val && val.length > 0) || "Unknown Location";
            const countryStr = addr.country_code ? addr.country_code.toUpperCase() : "";
            setAddress(countryStr ? `${locationStr}, ${countryStr}` : locationStr);
          }
        }

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
          const data = await weatherRes.value.json();
          const info = getWeatherInfo(data.current.weather_code);
          setWeather({ temp: data.current.temperature_2m, code: data.current.weather_code, description: info.label });
        }
      } catch (err) {} finally { 
        setIsCtxLoading(false); 
      }
    };
    
    fetchData();
    return () => controller.abort();
  }, [debouncedCoords]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4 overflow-hidden touch-manipulation select-none">
      <div className="w-full max-w-7xl flex flex-col items-center justify-start space-y-8 md:space-y-12 pb-10">
        
        <CompassDisplay 
          heading={heading}
          trueHeading={trueHeading}
          onClick={requestAccess} 
          hasError={!!compassError}
          permissionGranted={permissionGranted}
        />

        {loading && !coords && (
          <div className="animate-pulse flex flex-col items-center space-y-4 pt-10">
            <RefreshCcw className="w-5 h-5 animate-spin text-muted-foreground/60" />
            <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-medium">Acquiring Satellites</span>
          </div>
        )}

        {error && !coords && (
          <Alert variant="destructive" className="max-w-xs bg-transparent border border-destructive/30 text-center p-4 backdrop-blur-sm">
             <AlertTitle className="text-sm font-bold uppercase tracking-widest mb-1">Location Error</AlertTitle>
             <AlertDescription className="text-xs opacity-90">{error}</AlertDescription>
          </Alert>
        )}

        {/* Note: `coords` is passed raw (not debounced) for instant display */}
        {coords && (
          <div className="w-full flex flex-col items-center gap-8 md:gap-12 animate-in slide-in-from-bottom-4 fade-in duration-700">
            
            {/* Coordinate Grid */}
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden xl:block h-16 w-px bg-border/40" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            {/* Live Stats */}
            <div className="flex flex-wrap justify-center gap-6 md:gap-16 border-t border-border/20 pt-8 w-full max-w-2xl">
                {coords.altitude !== null && (
                    <StatMinimal icon={Mountain} label="Alt" value={`${Math.round(coords.altitude)} m`} />
                )}
                <StatMinimal 
                    icon={Activity} 
                    label="Spd" 
                    value={coords.speed ? `${(coords.speed * 3.6).toFixed(1)} km/h` : '0.0 km/h'} 
                />
                <StatMinimal 
                    icon={Navigation} 
                    label="Acc" 
                    value={coords.accuracy ? `±${coords.accuracy.toFixed(0)} m` : '--'} 
                />
            </div>

            {/* Context Pill (Address/Weather) */}
            <div className="w-full flex flex-col items-center gap-3 mt-2">
              <button 
                onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`, '_blank')}
                className="group flex items-center gap-2.5 text-muted-foreground hover:text-foreground transition-all duration-300 px-4 py-2 rounded-full hover:bg-muted/30 active:scale-95"
              >
                <MapPin className="w-4 h-4 text-red-500/80 group-hover:scale-110 transition-transform" />
                {(!address && isCtxLoading) ? (
                   <div className="h-4 w-32 bg-muted-foreground/10 animate-pulse rounded" />
                ) : (
                   <span className="text-lg font-light tracking-wide text-center">
                     {address || "Locating..."}
                   </span>
                )}
              </button>

              {weather && (
                  <div className="flex items-center gap-3 text-muted-foreground/60 px-4 py-1.5 rounded-full border border-transparent bg-muted/10 backdrop-blur-sm">
                    <WeatherIcon className="w-4 h-4" />
                    <span className="text-sm font-medium text-foreground tabular-nums">{weather.temp.toFixed(0)}°</span>
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