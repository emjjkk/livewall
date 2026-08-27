export type WallpaperType = 'image' | 'video' | 'webpage';

export interface AppSettings {
  wallpaper_type: WallpaperType;
  wallpaper_src: string;
  autostart: boolean;
  pause_on_battery: boolean;
  pause_on_unfocus: boolean;
  volume: number;
  is_muted: boolean;
}
