"use client";

import { useState, useEffect, useRef, useMemo } from 'react';
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
  CloudSun
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

// --- Helpers ---

// 1. Coordinate Formatter
const formatCoordinate = (value: number, type: 'lat' | 'lng'): string => {
  const direction = type === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(7)}°${direction}`;
};

// 2. Weather Code Interpreter (WMO Codes)
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

// 1. Geolocation
const useGeolocation = (options?: PositionOptions) => {
  const [state, setState] = useState<GeoState>({
    coords: null,
    error: null,
    loading: true,
  });
  const watcherRef = useRef<number | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setState((s) => ({ ...s, loading: false, error: "Geolocation not supported." }));
      return;
    }

    const handleSuccess = ({ coords }: GeolocationPosition) => {
      setState((prev) => {
        if (prev.coords && 
            prev.coords.latitude === coords.latitude && 
            prev.coords.longitude === coords.longitude) {
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

    watcherRef.current = navigator.geolocation.watchPosition(
      handleSuccess,
      handleError,
      options ?? { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => {
      if (watcherRef.current !== null) navigator.geolocation.clearWatch(watcherRef.current);
    };
  }, [options]);

  return state;
};

// 2. Debounce
const useDebounce = <T,>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
};

// 3. Weather Hook
const useWeather = (coords: Coordinates | null) => {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  
  useEffect(() => {
    if (!coords) return;
    
    const fetchWeather = async () => {
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=temperature_2m,weather_code&timezone=auto`
        );
        const data = await res.json();
        const info = getWeatherInfo(data.current.weather_code);
        
        setWeather({
          temp: data.current.temperature_2m,
          code: data.current.weather_code,
          description: info.label
        });
      } catch (e) {
        console.error("Weather fetch failed", e);
      }
    };

    fetchWeather();
  }, [coords]);

  return weather;
};

// --- UI Sub-Component ---
const CoordinateDisplay = ({ label, value, type }: { label: string; value: number; type: 'lat' | 'lng' }) => {
  const formattedValue = useMemo(() => formatCoordinate(value, type), [value, type]);
  
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedValue);
      const el = document.getElementById(`val-${type}`);
      if (el) {
        el.style.transition = "none"; 
        el.style.color = "var(--accent)";
        setTimeout(() => {
          el.style.transition = "color 300ms ease";
          el.style.color = "";
        }, 150);
      }
    } catch (err) { console.error(err); }
  };

  return (
    <div 
      className="group cursor-pointer flex flex-col items-center justify-center transition-transform duration-200 hover:scale-105 active:scale-95"
      onClick={handleCopy}
      title="Click to copy"
      role="button"
      tabIndex={0}
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
};

// --- Main Component ---
export default function GeoLocation() {
  const { coords, error, loading } = useGeolocation();
  const [address, setAddress] = useState<string | null>(null);
  const [isAddressLoading, setIsAddressLoading] = useState(false);
  
  // Debounce logic
  const debouncedCoords = useDebounce(coords, 1200);
  
  // Fetch Weather using debounced coords
  const weather = useWeather(debouncedCoords);

  // Address Fetching
  useEffect(() => {
    if (!debouncedCoords) return;
    const controller = new AbortController();
    
    const fetchAddress = async () => {
      setIsAddressLoading(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${debouncedCoords.latitude}&lon=${debouncedCoords.longitude}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("Error");
        const data = await res.json();
        const addr = data.address;
        const city = addr.city || addr.town || addr.village || addr.county || addr.state_district || addr.suburb;
        setAddress([city, addr.country].filter(Boolean).join(', '));
      } catch (err) { 
        /* ignore */ 
      } finally {
        setIsAddressLoading(false);
      }
    };

    fetchAddress();
    return () => controller.abort();
  }, [debouncedCoords]);

  // Determine dynamic weather icon
  const WeatherIcon = weather ? getWeatherInfo(weather.code).icon : Sun;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4">
      <div className="w-full max-w-7xl flex flex-col items-center justify-center space-y-8 md:space-y-12">
        
        {/* Loading */}
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

        {/* Error */}
        {error && !coords && (
          <Alert variant="destructive" className="max-w-md border-none bg-transparent text-center p-0">
            <div className="flex flex-col items-center gap-3">
              <Terminal className="h-8 w-8 opacity-50" />
              <AlertTitle className="text-xl font-bold">Location Error</AlertTitle>
              <AlertDescription className="text-muted-foreground">{error}</AlertDescription>
            </div>
          </Alert>
        )}

        {/* Success */}
        {coords && (
          <>
            <div className="flex flex-col xl:flex-row gap-8 xl:gap-24 items-center justify-center animate-fade-in text-center">
              <CoordinateDisplay label="Latitude" value={coords.latitude} type="lat" />
              <div className="hidden xl:block h-24 w-px bg-border/40" />
              <CoordinateDisplay label="Longitude" value={coords.longitude} type="lng" />
            </div>

            {/* Context Info (Address + Weather) */}
            <div className="flex flex-col items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-700">
              
              {/* Address */}
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="w-4 h-4 text-accent" />
                <span className={`text-lg md:text-xl font-light tracking-wide transition-opacity duration-500 ${isAddressLoading ? 'opacity-50' : 'opacity-100'}`}>
                  {address || (isAddressLoading ? "Identifying location..." : "Unknown Location")}
                </span>
              </div>

              {/* Weather */}
              {weather && (
                <div className="flex items-center gap-3 text-muted-foreground/80 bg-muted/20 px-4 py-1.5 rounded-full border border-border/50">
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

            {/* Footer */}
            {coords.accuracy && (
              <p className="fixed bottom-8 text-xs text-muted-foreground/30 font-mono select-none">
                GPS Accuracy: ±{coords.accuracy.toFixed(0)}m
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}