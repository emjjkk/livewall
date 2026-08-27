import { useState, ChangeEvent } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { AppSettings } from '../types/settings';
import { ToggleOption } from '../components/ToggleOption';

interface SettingsWindowProps {
  settings: AppSettings;
  onUpdate: (cfg: AppSettings) => void;
}

export function SettingsWindow({ settings, onUpdate }: SettingsWindowProps) {
  const [urlInput, setUrlInput] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isVideo = file.type.startsWith('video/');

    setIsSavingFile(true);
    try {
      // Persist the file to disk (instead of a session-only blob: URL) so the
      // wallpaper still loads after the app restarts, including on autostart.
      const buffer = await file.arrayBuffer();
      const savedPath = await invoke<string>('save_wallpaper_file', {
        fileName: file.name,
        data: Array.from(new Uint8Array(buffer)),
      });

      onUpdate({
        ...settings,
        wallpaper_type: isVideo ? 'video' : 'image',
        wallpaper_src: convertFileSrc(savedPath),
      });
    } catch (err) {
      console.error('Failed to save wallpaper file:', err);
    } finally {
      setIsSavingFile(false);
      // Allow re-selecting the same file again later
      e.target.value = '';
    }
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
              disabled={isSavingFile}
              className="w-full text-xs text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer disabled:opacity-50"
            />
            {isSavingFile && (
              <p className="text-[11px] text-slate-400">Saving file…</p>
            )}
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
                type="button"
                onClick={handleUrlApply}
                className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors cursor-pointer"
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
                type="button"
                onClick={() => toggleSetting('is_muted')}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
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
