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
  Compass,
  Navigation,
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

// Extend standard event to support iOS properties
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

// --- Custom Hooks ---

// 1. Geolocation Hook
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

// 2. Compass Hook (Fixed Types)
const useCompass = () => {
  const [heading, setHeading] = useState<number | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestAccess = useCallback(async () => {
    // iOS 13+ Check
    const isIOS = typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
    
    if (isIOS) {
      try {
        const response = await (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission!();
        if (response === 'granted') {
          setPermissionGranted(true);
          setError(null);
        } else {
          setError("Compass permission denied");
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

  useEffect(() => {
    if (!permissionGranted) return;

    let animationFrameId: number;
    
    const handleOrientation = (e: Event) => {
      const event = e as DeviceOrientationEventiOS;
      
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        let compass: number | null = null;
        
        // iOS
        if (typeof event.webkitCompassHeading === 'number') {
          compass = event.webkitCompassHeading;
        } 
        // Android / Standard
        else if (event.alpha !== null) {
          compass = 360 - event.alpha; 
        }

        if (compass !== null) {
          compass = (compass + 360) % 360;
          setHeading(compass);
        }
      });
    };

    // FIX: Cast window to 'any' to avoid "Property does not exist on type 'never'"
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

// 3. Debounce Hook
const useDebounce = <T,>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
};

// --- UI Components ---

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
      <span className="text-xs md:text-sm text-muted-foreground uppercase tracking-[0.2em] mb-2 font-semibold select-none">
        {label}
      </span>
      <span 
        id={`val-${type}`}
        className="text-4xl md:text-6xl lg:text-7xl font-black tracking-tighter font-mono transition-colors duration-300 select-all whitespace-nowrap"
      >
        {formattedValue}
      </span>
    </div>
  );
});
CoordinateDisplay.displayName = "CoordinateDisplay";

const SmallCompass = memo(({ heading, onClick, hasError }: { heading: number | null, onClick: () => void, hasError: boolean }) => {
  return (
    <div 
      className={`relative flex items-center justify-center w-10 h-10 rounded-full bg-muted/20 border transition-colors ${hasError ? 'border-destructive/50 bg-destructive/10' : 'border-border/50 hover:bg-muted/30 cursor-pointer'}`}
      onClick={onClick}
      title={heading ? `${heading.toFixed(0)}°` : "Click to enable compass"}
    >
      {hasError ? (
        <AlertCircle className="w-5 h-5 text-destructive" />
      ) : !heading ? (
        <Compass className="w-5 h-5 text-muted-foreground" />
      ) : (
        <div 
          className="w-full h-full relative flex items-center justify-center transition-transform duration-100 ease-out will-change-transform"
          style={{ transform: `rotate(${-heading}deg)` }}
        >
          <div className="absolute top-1 w-1.5 h-1.5 bg-red-500 rounded-full shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
          <Navigation className="w-5 h-5 text-foreground fill-foreground" />
          <div className="absolute top-0 w-[1px] h-1.5 bg-muted-foreground/30" />
          <div className="absolute bottom-0 w-[1px] h-1.5 bg-muted-foreground/30" />
          <div className="absolute left-0 h-[1px] w-1.5 bg-muted-foreground/30" />
          <div className="absolute right-0 h-[1px] w-1.5 bg-muted-foreground/30" />
        </div>
      )}
    </div>
  );
});
SmallCompass.displayName = "SmallCompass";

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
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4">
      <div className="w-full max-w-7xl flex flex-col items-center justify-center space-y-8 md:space-y-12">
        
        {loading && !coords && (
          <div className="animate-pulse flex flex-col items-center space-y-8">
            <div className="h-16 w-64 bg-muted/20 rounded-md" />
            <div className="h-16 w-64 bg-muted/20 rounded-md" />
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCcw className="w-4 h-4 animate-spin" />
              <span className="text-sm tracking-widest uppercase">Acquiring GPS...</span>
            </div>
          </div>
        )}

        {error && !coords && (
          <Alert variant="destructive" className="max-w-md border-none bg-transparent text-center p-0">
            <div className="flex flex-col items-center gap-3">
              <Terminal className="h-8 w-8 opacity-50" />
              <AlertTitle className="text-xl font-bold">Location Error</AlertTitle>
              <AlertDescription className="text-muted-foreground">{error}</AlertDescription>
            </div>
          </Alert>
        )}

        {coords && (
          <>
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center animate-fade-in text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden xl:block h-24 w-px bg-border/40" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            <div className="min-h-[80px] flex flex-col items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-700">
              <div className="flex items-center gap-2 text-muted-foreground h-6">
                <MapPin className="w-4 h-4 text-accent" />
                <span className={`text-lg md:text-xl font-light tracking-wide transition-opacity duration-500 ${isCtxLoading ? 'opacity-50' : 'opacity-100'}`}>
                  {address || (isCtxLoading ? "Identifying location..." : "Unknown Location")}
                </span>
              </div>

              <div className={`flex items-center gap-3 transition-all duration-500 ${weather ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
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

                <SmallCompass 
                  heading={heading} 
                  onClick={requestAccess} 
                  hasError={!!compassError}
                />
                
                {!permissionGranted && !compassError && (
                   <span className="text-[10px] text-muted-foreground/40 uppercase tracking-widest animate-pulse">
                     Tap Compass
                   </span>
                )}
              </div>
            </div>

            {coords.accuracy && (
              <p className="fixed bottom-8 text-xs text-muted-foreground/30 font-mono select-none">
                GPS ±{coords.accuracy.toFixed(0)}m
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}