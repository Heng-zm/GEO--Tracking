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
  Navigation,
  Mountain, // For Altitude
  Activity  // For Speed
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button"; // Assuming you have this, or standard button

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
  if (code === 0) return { label: "Clear Sky", icon: Sun };
  if (code >= 1 && code <= 3) return { label: "Partly Cloudy", icon: CloudSun };
  if (code >= 45 && code <= 48) return { label: "Foggy", icon: CloudFog };
  if (code >= 51 && code <= 67) return { label: "Rain", icon: CloudRain };
  if (code >= 71 && code <= 77) return { label: "Snow", icon: Snowflake };
  if (code >= 80 && code <= 82) return { label: "Heavy Rain", icon: CloudRain };
  if (code >= 95) return { label: "Thunderstorm", icon: CloudLightning };
  return { label: "Overcast", icon: Cloud };
};

const getCompassDirection = (degree: number) => {
  // Normalize to 0-360
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
        // Optimization: prevent re-renders if core data hasn't changed
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.accuracy === coords.accuracy &&
            prev.coords.altitude === coords.altitude &&
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
        case error.PERMISSION_DENIED: message = "Location access denied. Please enable GPS."; break;
        case error.POSITION_UNAVAILABLE: message = "Location unavailable. Check GPS signal."; break;
        case error.TIMEOUT: message = "Location request timed out."; break;
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
  // We store "visualHeading" which can exceed 360 to allow smooth rotation
  const [visualHeading, setVisualHeading] = useState<number | null>(null);
  const [trueHeading, setTrueHeading] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Track the previous heading to calculate shortest rotation path
  const prevHeadingRef = useRef<number>(0);
  const cumulativeRotationRef = useRef<number>(0);

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
        setError("Compass not supported");
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
          // iOS: Direct magnetic heading
          newHeading = event.webkitCompassHeading;
        } else if (event.alpha !== null) {
          // Android: alpha is usually counter-clockwise from North
          newHeading = 360 - event.alpha; 
        }

        if (newHeading !== null) {
          // Normalize to 0-360
          const normalizedHeading = (newHeading + 360) % 360;
          setTrueHeading(normalizedHeading);

          // Smart Interpolation Logic:
          // Calculate the shortest path difference between current visual rotation and new heading
          // Example: Going from 350 to 10 should be +20 degrees, not -340 degrees.
          
          let delta = normalizedHeading - (cumulativeRotationRef.current % 360);
          
          // Adjust delta for shortest path
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          
          cumulativeRotationRef.current += delta;
          setVisualHeading(cumulativeRotationRef.current);
        }
      });
    };

    const win = window as any;
    // Prefer absolute orientation for True North on Android
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
      <div 
        className="relative w-64 h-64 md:w-80 md:h-80 cursor-pointer group tap-highlight-transparent transition-transform active:scale-95"
        onClick={onClick}
        title={permissionGranted ? "Compass Active" : "Tap to enable compass"}
      >
         {/* Bezel */}
         <div className="absolute inset-0 rounded-full bg-gradient-to-br from-card to-background border-[8px] border-border shadow-2xl flex items-center justify-center">
            
            <div className="relative w-full h-full p-2">
               {/* Fixed Dial */}
               <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none">
                  {/* Ticks */}
                  {[...Array(60)].map((_, i) => {
                     const isMajor = i % 15 === 0;
                     const isMinor = i % 5 === 0;  
                     const length = isMajor ? 10 : isMinor ? 7 : 3;
                     const width = isMajor ? 1.5 : isMinor ? 0.8 : 0.4;
                     return (
                        <line 
                          key={i} 
                          x1="50" y1="2" 
                          x2="50" y2={2 + length} 
                          transform={`rotate(${i * 6} 50 50)`} 
                          stroke="currentColor" 
                          strokeWidth={width} 
                          className={isMajor ? "text-foreground" : "text-muted-foreground"}
                        />
                     )
                  })}
                  
                  {/* Labels */}
                  <text x="50" y="22" textAnchor="middle" className="text-[8px] font-black fill-red-500">N</text>
                  <text x="82" y="53" textAnchor="middle" className="text-[7px] font-bold fill-foreground">E</text>
                  <text x="50" y="85" textAnchor="middle" className="text-[7px] font-bold fill-foreground">S</text>
                  <text x="18" y="53" textAnchor="middle" className="text-[7px] font-bold fill-foreground">W</text>
                  
                  <g className="fill-muted-foreground opacity-60">
                    <text x="71" y="31" textAnchor="middle" className="text-[3px] font-medium">NE</text>
                    <text x="71" y="73" textAnchor="middle" className="text-[3px] font-medium">SE</text>
                    <text x="29" y="73" textAnchor="middle" className="text-[3px] font-medium">SW</text>
                    <text x="29" y="31" textAnchor="middle" className="text-[3px] font-medium">NW</text>
                  </g>

                  {/* SVG Needle */}
                  <g 
                    transform={`rotate(${rotation} 50 50)`}
                    className="will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
                  >
                     {/* Needle Drop Shadow */}
                     <path d="M50 15 L55 50 L50 85 L45 50 Z" fill="black" opacity="0.3" transform="translate(1, 2)" />
                     
                     {/* North (Red) */}
                     <path d="M50 15 L55 50 L50 50 L45 50 Z" fill="#EF4444" />
                     
                     {/* South (White/Foreground) */}
                     <path d="M50 85 L55 50 L50 50 L45 50 Z" className="fill-foreground" />
                     
                     {/* Center Pin */}
                     <circle cx="50" cy="50" r="2" className="fill-background stroke-muted-foreground stroke-[0.5]" />
                  </g>
               </svg>
            </div>
         </div>

         {!permissionGranted && !hasError && (
             <div className="absolute inset-0 flex items-center justify-center rounded-full z-20">
                <span className="text-xs font-bold uppercase tracking-widest bg-background/90 text-foreground px-4 py-2 rounded-full border shadow-lg animate-pulse">
                   Tap to Enable
                </span>
             </div>
         )}
         {hasError && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-destructive/10 z-20 backdrop-blur-sm">
                <AlertCircle className="w-8 h-8 text-destructive" />
            </div>
         )}
      </div>

      <div className="mt-8 flex flex-col items-center">
        <div className="text-5xl font-mono font-black tracking-tighter tabular-nums text-foreground">
          {trueHeading !== null ? trueHeading.toFixed(0) : "--"}°
        </div>
        <div className="text-sm font-bold text-muted-foreground tracking-[0.3em] uppercase mt-2">
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
      className="group cursor-pointer flex flex-col items-center justify-center transition-transform duration-200 hover:scale-105 active:scale-95"
      onClick={handleCopy}
    >
      <span className={`text-xs uppercase tracking-[0.2em] mb-1 font-semibold select-none transition-colors ${copied ? "text-accent" : "text-muted-foreground"}`}>
        {copied ? "COPIED" : label}
      </span>
      <span 
        className={`text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter font-mono transition-colors duration-300 select-all whitespace-nowrap ${copied ? "text-accent" : ""}`}
      >
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

const StatPill = ({ icon: Icon, label, value }: { icon: any, label: string, value: string }) => (
    <div className="flex flex-col items-center justify-center p-3 rounded-lg bg-muted/10 border border-border/40 min-w-[100px]">
        <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
            <Icon className="w-3.5 h-3.5" />
            <span className="text-[10px] uppercase tracking-wider font-semibold">{label}</span>
        </div>
        <span className="text-lg font-mono font-bold text-foreground">
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
      <div className="w-full max-w-7xl flex flex-col items-center justify-start space-y-10">
        
        {/* Compass */}
        <CompassDisplay 
          heading={visualHeading}
          trueHeading={trueHeading}
          onClick={requestAccess} 
          hasError={!!compassError}
          permissionGranted={permissionGranted}
        />

        {loading && !coords && (
          <div className="animate-pulse flex flex-col items-center space-y-4">
            <RefreshCcw className="w-5 h-5 animate-spin text-muted-foreground" />
            <span className="text-xs tracking-widest uppercase text-muted-foreground">Triangulating Position...</span>
          </div>
        )}

        {error && !coords && (
          <Alert variant="destructive" className="max-w-md bg-transparent border-destructive/20 text-center">
             <AlertTitle>Location Error</AlertTitle>
             <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {coords && (
          <div className="w-full flex flex-col items-center gap-10 animate-fade-in">
            {/* Coordinates */}
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden xl:block h-16 w-px bg-border/40" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            {/* Extra Stats: Altitude & Speed (Only if valid) */}
            <div className="flex gap-4">
                {coords.altitude !== null && (
                    <StatPill icon={Mountain} label="Altitude" value={`${Math.round(coords.altitude)}m`} />
                )}
                {coords.speed !== null && coords.speed > 0 && (
                    <StatPill icon={Activity} label="Speed" value={`${(coords.speed * 3.6).toFixed(1)} km/h`} />
                )}
            </div>

            {/* Address & Weather & Accuracy */}
            <div className="w-full flex flex-col items-center gap-5 pb-8">
              {/* Address (Clickable) */}
              <button 
                onClick={openMaps}
                className="group flex items-center gap-2 text-muted-foreground hover:text-accent transition-colors"
                title="Open in Google Maps"
              >
                <MapPin className="w-4 h-4 text-accent group-hover:scale-110 transition-transform" />
                <span className={`text-lg font-light text-center decoration-dotted underline-offset-4 group-hover:underline ${isCtxLoading ? 'opacity-50' : 'opacity-100'}`}>
                  {address || "Identifying location..."}
                </span>
              </button>

              {/* Weather */}
              {weather && (
                  <div className="flex items-center gap-3 text-muted-foreground/80 bg-muted/20 px-4 py-2 rounded-full border border-border/50">
                    <WeatherIcon className="w-4 h-4" />
                    <span className="text-sm font-medium">{weather.temp.toFixed(1)}°C</span>
                    <span className="text-xs opacity-50 border-l border-foreground/20 pl-3 uppercase tracking-wider">{weather.description}</span>
                  </div>
              )}

              {/* Accuracy */}
              {coords.accuracy && (
                <p className="text-[10px] text-muted-foreground/30 font-mono uppercase tracking-widest mt-2">
                  GPS Precision ±{coords.accuracy.toFixed(0)}m
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}