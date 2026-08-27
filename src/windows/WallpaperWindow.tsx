import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../types/settings';

interface WallpaperWindowProps {
  settings: AppSettings;
}

export function WallpaperWindow({ settings }: WallpaperWindowProps) {
  const [isPaused, setIsPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Focus & battery pausing logic
  useEffect(() => {
    let batteryInterval: ReturnType<typeof setInterval>;

    const evaluatePauseConditions = async () => {
      let pause = false;

      // 1. Desktop focus check
      if (settings.pause_on_unfocus && !document.hasFocus()) {
        pause = true;
      }

      // 2. Battery power check
      if (settings.pause_on_battery && !pause) {
        try {
          const onBattery = await invoke<boolean>('check_is_on_battery');
          if (onBattery) pause = true;
        } catch {
          if ('getBattery' in navigator) {
            const battery: any = await (navigator as any).getBattery();
            if (!battery.charging) pause = true;
          }
        }
      }

      setIsPaused(pause);
    };

    const handleFocus = () => evaluatePauseConditions();
    const handleBlur = () => evaluatePauseConditions();

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    // Focus changes are already caught instantly by the listeners above; this
    // interval only exists to catch AC-power-source changes, which don't have
    // a native event. 15s instead of 4s - a plugged/unplugged transition
    // being reflected up to 15s late is imperceptible on a wallpaper, and
    // this cuts the IPC round-trips roughly 4x.
    batteryInterval = setInterval(evaluatePauseConditions, 15000);
    evaluatePauseConditions();

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      clearInterval(batteryInterval);
    };
  }, [settings.pause_on_battery, settings.pause_on_unfocus]);

  // Video element playback and audio management
  useEffect(() => {
    if (videoRef.current) {
      if (isPaused) {
        videoRef.current.pause();
      } else {
        videoRef.current.play().catch(() => {});
      }
      videoRef.current.volume = settings.is_muted ? 0 : settings.volume;
    }
  }, [isPaused, settings.volume, settings.is_muted, settings.wallpaper_src]);

  // Playback watchdog: WebView2/Chromium can pause or stall media on windows it
  // considers backgrounded/occluded (which our wallpaper window always is, since
  // it sits behind the desktop icons). This resumes playback whenever the video
  // stops on its own without us having asked it to (isPaused is false).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || settings.wallpaper_type !== 'video') return;

    const resumeIfNeeded = () => {
      if (!isPaused && video.paused) {
        video.play().catch(() => {});
      }
    };

    video.addEventListener('pause', resumeIfNeeded);
    video.addEventListener('suspend', resumeIfNeeded);
    video.addEventListener('stalled', resumeIfNeeded);
    document.addEventListener('visibilitychange', resumeIfNeeded);

    // 8s instead of 4s - this is only a safety net for the rare case the
    // event listeners above miss a stall; halving the wake-up rate is free.
    const watchdog = setInterval(resumeIfNeeded, 8000);

    return () => {
      video.removeEventListener('pause', resumeIfNeeded);
      video.removeEventListener('suspend', resumeIfNeeded);
      video.removeEventListener('stalled', resumeIfNeeded);
      document.removeEventListener('visibilitychange', resumeIfNeeded);
      clearInterval(watchdog);
    };
  }, [isPaused, settings.wallpaper_type]);

  // Webpage postMessage sync for audio
  useEffect(() => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          type: 'SET_AUDIO',
          volume: settings.is_muted ? 0 : settings.volume,
          isPaused,
        },
        '*'
      );
    }
  }, [settings.volume, settings.is_muted, isPaused]);

  return (
    <main className="w-screen h-screen overflow-hidden bg-black select-none pointer-events-none">
      {settings.wallpaper_type === 'webpage' ? (
        <iframe
          ref={iframeRef}
          src={settings.wallpaper_src}
          title="Wallpaper Webpage"
          className={`w-full h-full border-0 transition-opacity duration-300 ${
            isPaused ? 'opacity-30' : 'opacity-100'
          }`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : settings.wallpaper_type === 'video' ? (
        <video
          ref={videoRef}
          src={settings.wallpaper_src}
          autoPlay
          loop
          muted={settings.is_muted}
          playsInline
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            isPaused ? 'opacity-30' : 'opacity-100'
          }`}
        />
      ) : (
        <img
          src={settings.wallpaper_src}
          alt="Wallpaper"
          className="w-full h-full object-cover"
        />
      )}
    </main>
  );
}
