"use client";

import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { 
  Terminal, 
  MapPin, 
  RefreshCcw, 
  Sun, 
  Cloud, 
  CloudRain, 
  CloudLightning, 
  Snowflake, 
  CloudFog,
  CloudSun,
  AlertCircle,
  Mountain,
  Activity,
  Navigation
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- Types ---
type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
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

// iOS specific event extension
interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Helpers ---
const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(7)}°${direction}`;
};

const getWeatherInfo = (code: number) => {
  if (code === 0) return { label: "Clear", icon: Sun };
  if (code >= 1 && code <= 3) return { label: "Cloudy", icon: CloudSun };
  if (code >= 45 && code <= 48) return { label: "Fog", icon: CloudFog };
  if (code >= 51 && code <= 67) return { label: "Rain", icon: CloudRain };
  if (code >= 71 && code <= 77) return { label: "Snow", icon: Snowflake };
  if (code >= 80 && code <= 82) return { label: "Heavy Rain", icon: CloudRain };
  if (code >= 95) return { label: "Storm", icon: CloudLightning };
  return { label: "Overcast", icon: Cloud };
};

const getCompassDirection = (degree: number) => {
  const normalized = ((degree % 360) + 360) % 360;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
};

// --- Custom Hooks ---

const useGeolocation = (options?: PositionOptions) => {
  const [state, setState] = useState<GeoState>({
    coords: null,
    error: null,
    loading: true,
  });
  const stableOptions = useRef(options);

  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setState((s) => ({ ...s, loading: false, error: "Geolocation not supported." }));
      return;
    }

    const handleSuccess = ({ coords }: GeolocationPosition) => {
      setState((prev) => {
        // Deep comparison optimization
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.accuracy === coords.accuracy &&
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
          },
          error: null,
          loading: false,
        };
      });
    };

    const handleError = (error: GeolocationPositionError) => {
      let message = "Unknown error";
      switch (error.code) {
        case error.PERMISSION_DENIED: message = "GPS access denied."; break;
        case error.POSITION_UNAVAILABLE: message = "GPS signal lost."; break;
        case error.TIMEOUT: message = "GPS request timed out."; break;
      }
      setState((s) => ({ ...s, loading: false, error: message }));
    };

    const watcher = navigator.geolocation.watchPosition(
      handleSuccess,
      handleError,
      stableOptions.current ?? { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
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
  const cumulativeRef = useRef(0);

  const requestAccess = useCallback(async () => {
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') {
          setPermissionGranted(true);
          setError(null);
        } else {
          setError("Compass denied");
        }
      } catch (e) {
        setError("Not supported");
      }
    } else {
      setPermissionGranted(true);
      setError(null);
    }
  }, []);

  useEffect(() => {
    if (!permissionGranted) return;
    let animationFrameId: number;
    
    const handleOrientation = (e: Event) => {
      const event = e as DeviceOrientationEventiOS;
      
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        let newHeading: number | null = null;
        
        if (typeof event.webkitCompassHeading === 'number') {
          // iOS
          newHeading = event.webkitCompassHeading;
        } else if (event.alpha !== null) {
          // Android (360 - alpha) usually gives clockwise heading from North
          newHeading = 360 - event.alpha; 
        }

        if (newHeading !== null) {
          // Normalize 0-360
          const normalized = (newHeading + 360) % 360;
          setTrueHeading(normalized);

          // Shortest Path Interpolation to prevent spinning
          let delta = normalized - (cumulativeRef.current % 360);
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          
          cumulativeRef.current += delta;
          setVisualHeading(cumulativeRef.current);
        }
      });
    };

    const win = window as any;
    const eventName = 'ondeviceorientationabsolute' in win ? 'deviceorientationabsolute' : 'deviceorientation';
    
    window.addEventListener(eventName, handleOrientation, true);
    return () => {
      window.removeEventListener(eventName, handleOrientation, true);
      cancelAnimationFrame(animationFrameId);
    };
  }, [permissionGranted]);

  return { visualHeading, trueHeading, requestAccess, permissionGranted, error };
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

  return (
    <div className="flex flex-col items-center justify-center mb-6 relative z-10 animate-in zoom-in-50 duration-700">
      {/* Clickable Compass Area */}
      <div 
        className="relative w-72 h-72 md:w-80 md:h-80 cursor-pointer group tap-highlight-transparent"
        onClick={onClick}
      >
         {/* Minimalist Dial (No borders/background) */}
         <div className="relative w-full h-full p-4">
           <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none">
              
              {/* Ticks */}
              {[...Array(60)].map((_, i) => {
                 const isMajor = i % 15 === 0; // N, E, S, W
                 const isMinor = i % 5 === 0;  
                 const length = isMajor ? 8 : isMinor ? 5 : 2;
                 const width = isMajor ? 1.2 : isMinor ? 0.6 : 0.3;
                 // Major ticks slightly brighter
                 const colorClass = isMajor ? "text-foreground" : "text-muted-foreground/50";
                 
                 return (
                    <line 
                      key={i} 
                      x1="50" y1="2" 
                      x2="50" y2={2 + length} 
                      transform={`rotate(${i * 6} 50 50)`} 
                      stroke="currentColor" 
                      strokeWidth={width} 
                      className={colorClass}
                    />
                 )
              })}
              
              {/* Cardinal Labels - Floating */}
              <text x="50" y="20" textAnchor="middle" className="text-[7px] font-black fill-red-500">N</text>
              <text x="82" y="52" textAnchor="middle" className="text-[6px] font-bold fill-foreground">E</text>
              <text x="50" y="85" textAnchor="middle" className="text-[6px] font-bold fill-foreground">S</text>
              <text x="18" y="52" textAnchor="middle" className="text-[6px] font-bold fill-foreground">W</text>

              {/* Minimal Needle */}
              <g 
                transform={`rotate(${rotation} 50 50)`}
                className="will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
              >
                 {/* North (Red Tip) */}
                 <path d="M50 15 L53 50 L50 50 L47 50 Z" fill="#EF4444" />
                 
                 {/* South (Ghost/Outline) */}
                 <path d="M50 85 L53 50 L50 50 L47 50 Z" className="fill-muted-foreground/50" />
                 
                 {/* Center Dot */}
                 <circle cx="50" cy="50" r="1.5" className="fill-background stroke-foreground stroke-[0.5]" />
              </g>
           </svg>
         </div>

         {/* Call to Action Overlay (if disabled) */}
         {!permissionGranted && !hasError && (
             <div className="absolute inset-0 flex items-center justify-center rounded-full z-20">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground animate-pulse">
                   Tap Compass
                </span>
             </div>
         )}
         {hasError && (
            <div className="absolute inset-0 flex items-center justify-center z-20">
                <AlertCircle className="w-8 h-8 text-destructive/80" />
            </div>
         )}
      </div>

      {/* Digital Heading (No Box) */}
      <div className="mt-4 flex flex-col items-center">
        <div className="text-6xl font-mono font-black tracking-tighter tabular-nums text-foreground">
          {trueHeading !== null ? trueHeading.toFixed(0) : "--"}°
        </div>
        <div className="text-sm font-bold text-muted-foreground tracking-[0.4em] uppercase mt-2">
          {directionStr}
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { 
        await navigator.clipboard.writeText(formattedValue); 
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      } catch (e) { }
    }
  };

  return (
    <div 
      className="group cursor-pointer flex flex-col items-center justify-center transition-all duration-200 hover:opacity-80 active:scale-95"
      onClick={handleCopy}
    >
      <span className={`text-[10px] uppercase tracking-[0.25em] mb-1 font-bold select-none transition-colors ${copied ? "text-accent" : "text-muted-foreground"}`}>
        {copied ? "COPIED" : label}
      </span>
      <span 
        className={`text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter font-mono transition-colors duration-300 select-all whitespace-nowrap ${copied ? "text-accent" : "text-foreground"}`}
      >
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

const StatMinimal = ({ icon: Icon, label, value }: { icon: any, label: string, value: string }) => (
    <div className="flex flex-col items-center justify-center min-w-[80px]">
        <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
            <Icon className="w-3 h-3 opacity-70" />
            <span className="text-[9px] uppercase tracking-widest font-semibold">{label}</span>
        </div>
        <span className="text-lg font-mono font-bold text-foreground/90">
            {value}
        </span>
    </div>
);

export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { visualHeading, trueHeading, requestAccess, permissionGranted, error: compassError } = useCompass();
  const [address, setAddress] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [isCtxLoading, setIsCtxLoading] = useState(false);
  const debouncedCoords = useDebounce(coords, 1200);

  useEffect(() => {
    if (!debouncedCoords) return;
    const controller = new AbortController();
    setIsCtxLoading(true);

    const fetchData = async () => {
      try {
        const [geoRes, weatherRes] = await Promise.allSettled([
          fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${debouncedCoords.latitude}&lon=${debouncedCoords.longitude}`, { signal: controller.signal }),
          fetch(`https://api.open-meteo.com/v1/forecast?latitude=${debouncedCoords.latitude}&longitude=${debouncedCoords.longitude}&current=temperature_2m,weather_code&timezone=auto`, { signal: controller.signal })
        ]);

        if (geoRes.status === 'fulfilled' && geoRes.value.ok) {
          const data = await geoRes.value.json();
          const addr = data.address;
          if (addr) {
            const city = addr.city || addr.town || addr.village || addr.county || addr.suburb || "";
            const country = addr.country || "";
            setAddress([city, country].filter(Boolean).join(', '));
          }
        }

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
          const data = await weatherRes.value.json();
          const info = getWeatherInfo(data.current.weather_code);
          setWeather({ temp: data.current.temperature_2m, code: data.current.weather_code, description: info.label });
        }
      } catch (err) { } finally { setIsCtxLoading(false); }
    };
    fetchData();
    return () => controller.abort();
  }, [debouncedCoords]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;

  const openMaps = () => {
    if (coords) {
        window.open(`https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`, '_blank');
    }
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4 py-8 overflow-x-hidden">
      <div className="w-full max-w-7xl flex flex-col items-center justify-start space-y-12">
        
        {/* Floating Compass */}
        <CompassDisplay 
          heading={visualHeading}
          trueHeading={trueHeading}
          onClick={requestAccess} 
          hasError={!!compassError}
          permissionGranted={permissionGranted}
        />

        {loading && !coords && (
          <div className="animate-pulse flex flex-col items-center space-y-4">
            <RefreshCcw className="w-4 h-4 animate-spin text-muted-foreground" />
            <span className="text-[10px] tracking-widest uppercase text-muted-foreground">Locating...</span>
          </div>
        )}

        {error && !coords && (
          <Alert variant="destructive" className="max-w-md bg-transparent border-destructive/20 text-center p-2">
             <AlertTitle className="text-sm">Location Error</AlertTitle>
             <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {coords && (
          <div className="w-full flex flex-col items-center gap-10 animate-fade-in">
            {/* Coordinates */}
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              {/* Minimal Divider */}
              <div className="hidden xl:block h-12 w-px bg-border/30" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            {/* Stats (Minimal, No Boxes) */}
            <div className="flex gap-12 border-t border-border/20 pt-6">
                {coords.altitude !== null && (
                    <StatMinimal icon={Mountain} label="Alt" value={`${Math.round(coords.altitude)}m`} />
                )}
                {coords.speed !== null && coords.speed > 0 && (
                    <StatMinimal icon={Activity} label="Spd" value={`${(coords.speed * 3.6).toFixed(1)} km/h`} />
                )}
                {/* Accuracy as a stat now */}
                {coords.accuracy && (
                    <StatMinimal icon={Navigation} label="Acc" value={`±${coords.accuracy.toFixed(0)}m`} />
                )}
            </div>

            {/* Footer Context (Address & Weather) */}
            <div className="w-full flex flex-col items-center gap-4">
              
              {/* Address (Clean Link Style) */}
              <button 
                onClick={openMaps}
                className="group flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                title="View on Maps"
              >
                <MapPin className="w-3.5 h-3.5 text-accent group-hover:scale-110 transition-transform" />
                <span className={`text-lg font-light tracking-wide text-center group-hover:underline underline-offset-4 decoration-dotted ${isCtxLoading ? 'opacity-50' : 'opacity-100'}`}>
                  {address || "Unknown Location"}
                </span>
              </button>

              {/* Weather (Floating Text/Icon) */}
              {weather && (
                  <div className="flex items-center gap-3 text-muted-foreground/70">
                    <WeatherIcon className="w-4 h-4" />
                    <span className="text-sm font-medium text-foreground">{weather.temp.toFixed(0)}°</span>
                    <span className="w-px h-3 bg-border" />
                    <span className="text-xs uppercase tracking-wider">{weather.description}</span>
                  </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}