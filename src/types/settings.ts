export type WallpaperType = "image" | "video" | "webpage";

export type ForwardingScope = "hardware" | "windows" | "media";

export interface WallpaperOverlay {
	id: string;
	url: string;

	// Position as a percentage of the wallpaper window.
	x: number;
	y: number;

	// Size in pixels.
	width: number;
	height: number;

	// When enabled, Livewall POSTs the selected scopes as JSON to
	// forwarding_url roughly every 5 seconds.
	forwarding_enabled: boolean;
	forwarding_url: string;
	forwarding_scopes: ForwardingScope[];
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