"use client";

import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Terminal } from 'lucide-react';

type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

export default function GeoLocation() {
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let watcher: number;

    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.");
      return;
    }

    const handleSuccess = (position: GeolocationPosition) => {
      setCoords({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      setError(null);
    };

    const handleError = (err: GeolocationPositionError) => {
      let message = "An unknown error occurred.";
      switch (err.code) {
        case err.PERMISSION_DENIED:
          message = "Location access denied. Please enable location services in your browser settings.";
          break;
        case err.POSITION_UNAVAILABLE:
          message = "Location information is unavailable.";
          break;
        case err.TIMEOUT:
          message = "The request to get user location timed out.";
          break;
      }
      setError(message);
    };

    watcher = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
    
    return () => {
      if (watcher) {
        navigator.geolocation.clearWatch(watcher);
      }
    };
  }, []);

  const renderContent = () => {
    if (error && !coords) {
      return (
        <Alert variant="destructive" className="max-w-md">
            <Terminal className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
                {error}
            </AlertDescription>
        </Alert>
      );
    }
    
    if (!coords) {
      return (
        <div className="space-y-6 w-full max-w-sm">
          <div className="p-6 border border-border rounded-lg shadow-lg bg-card text-center">
            <h2 className="text-xl text-muted-foreground mb-2">Latitude</h2>
            <Skeleton className="h-12 w-3/4 mx-auto" />
          </div>
          <div className="p-6 border border-border rounded-lg shadow-lg bg-card text-center">
            <h2 className="text-xl text-muted-foreground mb-2">Longitude</h2>
            <Skeleton className="h-12 w-3/4 mx-auto" />
          </div>
           <p className="text-sm text-center text-muted-foreground pt-4 animate-pulse">
            Requesting location permission...
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-6 animate-fade-in">
        <div className="p-6 border border-border rounded-lg shadow-lg bg-card text-center transition-all duration-300 hover:shadow-primary/20 hover:border-primary/50">
          <h2 className="text-xl text-muted-foreground mb-2 font-body">Latitude</h2>
          <p className="text-4xl md:text-5xl font-mono font-bold tracking-wider">{coords.latitude.toFixed(6)}</p>
        </div>
        <div className="p-6 border border-border rounded-lg shadow-lg bg-card text-center transition-all duration-300 hover:shadow-primary/20 hover:border-primary/50">
          <h2 className="text-xl text-muted-foreground mb-2 font-body">Longitude</h2>
          <p className="text-4xl md:text-5xl font-mono font-bold tracking-wider">{coords.longitude.toFixed(6)}</p>
        </div>
        {coords.accuracy != null && (
          <p className="text-sm text-center text-muted-foreground pt-4">
            Accuracy: <span className="font-semibold text-accent">{coords.accuracy.toFixed(0)} meters</span>
          </p>
        )}
      </div>
    );
  };
  
  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-4">
      <div className="text-center flex flex-col items-center">
        <h1 className="text-4xl md:text-6xl font-headline font-bold mb-12">GeoTrack Now</h1>
        {renderContent()}
      </div>
    </main>
  );
}
