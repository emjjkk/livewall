export type WallpaperType = "image" | "video" | "webpage";

export interface WallpaperOverlay {
	id: string;
	url: string;

	// Position as a percentage of the wallpaper window.
	x: number;
	y: number;

	// Size in pixels.
	width: number;
	height: number;
}

export interface AppSettings {
	wallpaper_type: WallpaperType;
	wallpaper_src: string;

	autostart: boolean;
	pause_on_battery: boolean;
	pause_on_unfocus: boolean;

	volume: number;
	is_muted: boolean;

	overlays: WallpaperOverlay[];
}
