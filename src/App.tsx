import { useState, useEffect, useRef, ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './globals.css';

export interface AppSettings {
  wallpaper_type: 'image' | 'video' | 'webpage';
  wallpaper_src: string;
  autostart: boolean;
  pause_on_battery: boolean;
  pause_on_unfocus: boolean;
  volume: number;
  is_muted: boolean;
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isSettingsWindow = params.has('settings');

  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    // Fetch initial settings from disk
    invoke<AppSettings>('get_settings')
      .then(setSettings)
      .catch(console.error);

    // Keep state in sync between main window & settings window
    const unlisten = listen<AppSettings>('settings-changed', (event) => {
      setSettings(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleUpdateSettings = async (newSettings: AppSettings) => {
    setSettings(newSettings);
    await invoke('update_settings', { newSettings });
  };

  // Pre-render buffer prevents settings window from flashing the wallpaper on load
  if (!settings) {
    return <div className="w-screen h-screen bg-slate-900" />;
  }

  if (isSettingsWindow) {
    return <SettingsView settings={settings} onUpdate={handleUpdateSettings} />;
  }

  return <WallpaperView settings={settings} />;
}

// --- Wallpaper Renderer ---
function WallpaperView({ settings }: { settings: AppSettings }) {
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

    batteryInterval = setInterval(evaluatePauseConditions, 4000);
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

// --- Settings View ---
function SettingsView({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (cfg: AppSettings) => void;
}) {
  const [urlInput, setUrlInput] = useState('');

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fileUrl = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');

    onUpdate({
      ...settings,
      wallpaper_type: isVideo ? 'video' : 'image',
      wallpaper_src: fileUrl,
    });
  };

  const handleUrlApply = () => {
    let url = urlInput.trim();
    if (!url) return;

    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    const isDirectVideo = /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url);
    const isDirectImage = /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url);

    let wallpaper_type: AppSettings['wallpaper_type'] = 'webpage';
    if (isDirectVideo) wallpaper_type = 'video';
    if (isDirectImage) wallpaper_type = 'image';

    onUpdate({
      ...settings,
      wallpaper_type,
      wallpaper_src: url,
    });

    setUrlInput('');
  };

  const toggleSetting = (key: keyof AppSettings) => {
    onUpdate({
      ...settings,
      [key]: !settings[key],
    });
  };

  return (
    <div className="p-5 w-full h-screen bg-slate-900 text-slate-100 flex flex-col justify-between select-none overflow-y-auto">
      <div className="space-y-6">
        {/* Source Configuration */}
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-800 pb-1.5">
            Wallpaper Source
          </h2>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">
              Upload Local File (Image / Video)
            </label>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={handleFileUpload}
              className="w-full text-xs text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">
              Webpage or Media URL
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                placeholder="https://example.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="flex-1 px-2.5 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded focus:outline-none focus:border-blue-500 text-slate-200"
              />
              <button
                onClick={handleUrlApply}
                className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </section>

        {/* Audio Configuration */}
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-800 pb-1.5">
            Audio Settings
          </h2>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs font-medium text-slate-300">
                Playback Volume
              </span>
              <button
                onClick={() => toggleSetting('is_muted')}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                  settings.is_muted
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {settings.is_muted ? 'Muted' : 'Mute'}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={settings.is_muted ? 0 : settings.volume}
                disabled={settings.is_muted}
                onChange={(e) =>
                  onUpdate({ ...settings, volume: parseFloat(e.target.value) })
                }
                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-40"
              />
              <span className="text-xs font-mono text-slate-400 w-9 text-right">
                {settings.is_muted ? '0%' : `${Math.round(settings.volume * 100)}%`}
              </span>
            </div>
          </div>
        </section>

        {/* System & Performance Controls */}
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-800 pb-1.5">
            Performance & System
          </h2>

          <ToggleOption
            label="Run on System Startup"
            description="Start live wallpaper automatically when Windows boots."
            checked={settings.autostart}
            onChange={() => toggleSetting('autostart')}
          />

          <ToggleOption
            label="Pause on Battery Power"
            description="Freeze animation/video on battery to conserve power."
            checked={settings.pause_on_battery}
            onChange={() => toggleSetting('pause_on_battery')}
          />

          <ToggleOption
            label="Pause when Unfocused"
            description="Pause playback while actively working in other apps."
            checked={settings.pause_on_unfocus}
            onChange={() => toggleSetting('pause_on_unfocus')}
          />
        </section>
      </div>

      <div className="pt-3 border-t border-slate-800 text-[11px] text-slate-500 truncate">
        Active Source:{' '}
        <span className="capitalize text-slate-300 font-medium">
          {settings.wallpaper_type}
        </span>
        <span className="block text-slate-400 truncate">{settings.wallpaper_src}</span>
      </div>

      <div className="pt-1 text-xs">
        <p>Built <a href="https://github.com/emjjkk/livewall" className='text-blue-300'>open-source</a> with Tauri + React by <a href="https://emjjkk.tech" className='text-blue-200'>@emjjkk</a></p>
      </div>
    </div>
  );
}

function ToggleOption({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="pr-4">
        <p className="text-xs font-medium text-slate-200">{label}</p>
        <p className="text-[11px] text-slate-400">{description}</p>
      </div>
      <button
        onClick={onChange}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
          checked ? 'bg-blue-600' : 'bg-slate-700'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}