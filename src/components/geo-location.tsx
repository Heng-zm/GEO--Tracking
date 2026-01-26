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
  AlertCircle
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// --- Types ---
type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
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

// Extend standard event for iOS support
interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// --- Static Helpers ---

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
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(((degree %= 360) < 0 ? degree + 360 : degree) / 45) % 8;
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
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude &&
            prev.coords.accuracy === coords.accuracy) {
          return prev;
        }
        return {
          coords: {
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
          },
          error: null,
          loading: false,
        };
      });
    };

    const handleError = (error: GeolocationPositionError) => {
      let message = "Unknown error";
      switch (error.code) {
        case error.PERMISSION_DENIED: message = "Location access denied"; break;
        case error.POSITION_UNAVAILABLE: message = "Location unavailable"; break;
        case error.TIMEOUT: message = "Location request timed out"; break;
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
  const [heading, setHeading] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        let compass: number | null = null;
        
        if (typeof event.webkitCompassHeading === 'number') {
          compass = event.webkitCompassHeading;
        } else if (event.alpha !== null) {
          compass = 360 - event.alpha; 
        }

        if (compass !== null) {
          compass = (compass + 360) % 360;
          setHeading(compass);
        }
      });
    };

    const win = window as any;
    if ('ondeviceorientationabsolute' in win) {
      win.addEventListener('deviceorientationabsolute', handleOrientation, true);
    } else {
      window.addEventListener('deviceorientation', handleOrientation, true);
    }

    return () => {
      if ('ondeviceorientationabsolute' in win) {
        win.removeEventListener('deviceorientationabsolute', handleOrientation, true);
      } else {
        window.removeEventListener('deviceorientation', handleOrientation);
      }
      cancelAnimationFrame(animationFrameId);
    };
  }, [permissionGranted]);

  return { heading, requestAccess, permissionGranted, error };
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

// 1. Optimized Compass UI (Top Center)
const CompassDisplay = memo(({ heading, onClick, hasError, permissionGranted }: { heading: number | null, onClick: () => void, hasError: boolean, permissionGranted: boolean }) => {
  const rotation = heading ? -heading : 0;
  const directionStr = heading ? getCompassDirection(heading) : "--";

  return (
    <div className="flex flex-col items-center justify-center mb-8 relative z-10">
      {/* Compass Container */}
      <div 
        className="relative w-64 h-64 md:w-80 md:h-80 cursor-pointer group transition-transform active:scale-95"
        onClick={onClick}
        title={permissionGranted ? "Compass Active" : "Tap to enable compass"}
      >
         {/* Bezel / Shadow */}
         <div className="absolute inset-0 rounded-full bg-background border-[6px] border-muted shadow-2xl flex items-center justify-center">
            
            {/* Compass Face (Fixed) */}
            <div className="relative w-full h-full p-2">
               <svg viewBox="0 0 100 100" className="w-full h-full select-none pointer-events-none">
                  {/* Ticks */}
                  {[...Array(60)].map((_, i) => {
                     const isMajor = i % 15 === 0; // N, E, S, W
                     const isMinor = i % 5 === 0;  
                     const length = isMajor ? 12 : isMinor ? 8 : 4;
                     const width = isMajor ? 1.5 : isMinor ? 0.8 : 0.4;
                     return (
                        <line 
                          key={i} 
                          x1="50" y1="2" 
                          x2="50" y2={2 + length} 
                          transform={`rotate(${i * 6} 50 50)`} 
                          stroke="currentColor" 
                          strokeWidth={width} 
                          className="text-foreground/80"
                        />
                     )
                  })}
                  
                  {/* Cardinal Labels */}
                  <text x="50" y="24" textAnchor="middle" className="text-[9px] font-black fill-red-500">N</text>
                  <text x="80" y="53" textAnchor="middle" className="text-[8px] font-bold fill-foreground">E</text>
                  <text x="50" y="85" textAnchor="middle" className="text-[8px] font-bold fill-foreground">S</text>
                  <text x="20" y="53" textAnchor="middle" className="text-[8px] font-bold fill-foreground">W</text>
                  
                  {/* Intercardinal Labels */}
                   <text x="70" y="32" textAnchor="middle" className="text-[4px] font-medium fill-muted-foreground">NE</text>
                   <text x="70" y="73" textAnchor="middle" className="text-[4px] font-medium fill-muted-foreground">SE</text>
                   <text x="30" y="73" textAnchor="middle" className="text-[4px] font-medium fill-muted-foreground">SW</text>
                   <text x="30" y="32" textAnchor="middle" className="text-[4px] font-medium fill-muted-foreground">NW</text>
               </svg>

               {/* Rotating Needle */}
               <div 
                  className="absolute inset-0 flex items-center justify-center transition-transform duration-500 ease-out will-change-transform"
                  style={{ transform: `rotate(${rotation}deg)` }}
               >
                  <div className="relative w-4 h-full">
                      {/* North Needle (Red) */}
                      <div className="absolute top-[12%] left-1/2 -translate-x-1/2 w-0 h-0 
                                      border-l-[6px] border-l-transparent 
                                      border-r-[6px] border-r-transparent 
                                      border-b-[50px] border-b-red-600 drop-shadow-md" />
                      
                      {/* South Needle (Dark/White) */}
                      <div className="absolute bottom-[12%] left-1/2 -translate-x-1/2 w-0 h-0 
                                      border-l-[6px] border-l-transparent 
                                      border-r-[6px] border-r-transparent 
                                      border-t-[50px] border-t-foreground drop-shadow-md" />
                      
                      {/* Center Pin */}
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-background border-2 border-foreground rounded-full z-10 shadow-sm" />
                  </div>
               </div>
            </div>
         </div>

         {/* Permission Overlay */}
         {!permissionGranted && !hasError && (
             <div className="absolute inset-0 flex items-center justify-center rounded-full bg-background/50 backdrop-blur-[2px]">
                <span className="text-xs font-bold uppercase tracking-widest bg-background px-3 py-1 rounded-full border shadow-sm animate-pulse">
                   Tap to Enable
                </span>
             </div>
         )}
         
         {hasError && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-destructive/10">
               <AlertCircle className="w-8 h-8 text-destructive" />
            </div>
         )}
      </div>

      {/* Digital Heading Readout */}
      <div className="mt-6 flex flex-col items-center">
        <div className="text-4xl font-mono font-black tracking-tighter tabular-nums">
          {heading ? heading.toFixed(0) : "--"}°
        </div>
        <div className="text-sm font-bold text-muted-foreground tracking-[0.2em] uppercase mt-1">
          {directionStr}
        </div>
      </div>
    </div>
  );
});
CompassDisplay.displayName = "CompassDisplay";

// 2. Coordinate Component
const CoordinateDisplay = memo(({ label, value, type }: { label: string; value: number; type: 'lat' | 'lng' }) => {
  const formattedValue = useMemo(() => formatCoordinate(value, type), [value, type]);
  
  const handleCopy = async () => {
    const triggerVisual = () => {
      const el = document.getElementById(`val-${type}`);
      if (el) {
        el.style.transition = "none"; 
        el.style.color = "var(--accent)";
        setTimeout(() => {
          el.style.transition = "color 300ms ease";
          el.style.color = "";
        }, 150);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(formattedValue);
        triggerVisual();
        return;
      } catch (e) { /* fallback */ }
    }

    try {
      const textArea = document.createElement("textarea");
      textArea.value = formattedValue;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      triggerVisual();
    } catch (e) {
      console.error("Copy failed", e);
    }
  };

  return (
    <div 
      className="group cursor-pointer flex flex-col items-center justify-center transition-transform duration-200 hover:scale-105 active:scale-95"
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      aria-label={`Copy ${label}`}
    >
      <span className="text-xs text-muted-foreground uppercase tracking-[0.2em] mb-1 font-semibold select-none">
        {label}
      </span>
      <span 
        id={`val-${type}`}
        // Reduced size slightly to balance with the large compass
        className="text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter font-mono transition-colors duration-300 select-all whitespace-nowrap"
      >
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

// --- Main Component ---
export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const { heading, requestAccess, permissionGranted, error: compassError } = useCompass();
  
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
          fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${debouncedCoords.latitude}&lon=${debouncedCoords.longitude}`,
            { signal: controller.signal }
          ),
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${debouncedCoords.latitude}&longitude=${debouncedCoords.longitude}&current=temperature_2m,weather_code&timezone=auto`,
            { signal: controller.signal }
          )
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
          setWeather({
            temp: data.current.temperature_2m,
            code: data.current.weather_code,
            description: info.label
          });
        }
      } catch (err) {
      } finally {
        setIsCtxLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [debouncedCoords]);

  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4 pt-8 pb-12">
      <div className="w-full max-w-7xl flex flex-col items-center justify-start space-y-12">
        
        {/* 1. COMPASS (Hero Element) */}
        <CompassDisplay 
          heading={heading} 
          onClick={requestAccess} 
          hasError={!!compassError}
          permissionGranted={permissionGranted}
        />

        {/* Loading State for Coords */}
        {loading && !coords && (
          <div className="animate-pulse flex flex-col items-center space-y-4 mt-8">
            <div className="h-12 w-48 bg-muted/20 rounded-md" />
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCcw className="w-4 h-4 animate-spin" />
              <span className="text-sm tracking-widest uppercase">Locating Satellites...</span>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !coords && (
          <Alert variant="destructive" className="max-w-md border-none bg-transparent text-center p-0 mt-8">
            <div className="flex flex-col items-center gap-3">
              <Terminal className="h-8 w-8 opacity-50" />
              <AlertTitle className="text-xl font-bold">Location Error</AlertTitle>
              <AlertDescription className="text-muted-foreground">{error}</AlertDescription>
            </div>
          </Alert>
        )}

        {/* Success State */}
        {coords && (
          <>
            {/* 2. Coordinates */}
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center animate-fade-in text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden xl:block h-16 w-px bg-border/40" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            {/* 3. Address & Weather Context */}
            <div className="min-h-[80px] flex flex-col items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-700">
              {/* Address */}
              <div className="flex items-center gap-2 text-muted-foreground h-6">
                <MapPin className="w-4 h-4 text-accent" />
                <span className={`text-lg font-light tracking-wide transition-opacity duration-500 ${isCtxLoading ? 'opacity-50' : 'opacity-100'}`}>
                  {address || (isCtxLoading ? "Identifying location..." : "Unknown Location")}
                </span>
              </div>

              {/* Weather */}
              <div className={`transition-all duration-500 ${weather ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
                {weather && (
                  <div className="flex items-center gap-3 text-muted-foreground/80 bg-muted/20 px-4 py-2 rounded-full border border-border/50">
                    <WeatherIcon className="w-4 h-4" />
                    <span className="text-sm font-medium">
                      {weather.temp.toFixed(1)}°C
                    </span>
                    <span className="text-xs opacity-50 border-l border-foreground/20 pl-3 uppercase tracking-wider">
                      {weather.description}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer Accuracy */}
            {coords.accuracy && (
              <p className="fixed bottom-6 text-[10px] text-muted-foreground/30 font-mono select-none">
                GPS Accuracy: ±{coords.accuracy.toFixed(0)}m
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}