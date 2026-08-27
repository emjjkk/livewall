import { useSettings } from './hooks/useSettings';
import { WallpaperWindow } from './windows/WallpaperWindow';
import { SettingsWindow } from './windows/SettingsWindow';

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isSettingsWindow = params.has('settings');

  const { settings, updateSettings } = useSettings();

  // Pre-render buffer prevents settings window from flashing the wallpaper on load
  if (!settings) {
    return <div className="w-screen h-screen bg-slate-900" />;
  }

  if (isSettingsWindow) {
    return <SettingsWindow settings={settings} onUpdate={updateSettings} />;
  }

  return <WallpaperWindow settings={settings} />;
}